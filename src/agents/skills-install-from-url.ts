import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { OpenClawConfig } from "../config/config.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { ensureDir, resolveUserPath } from "../utils.js";
import { extractArchive } from "./skills-install-extract.js";
import type { SkillInstallResult } from "./skills-install.js";

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value && typeof (value as NodeJS.ReadableStream).pipe === "function");
}

/** Safe directory name under workspace/skills/. */
export function sanitizeSkillDirName(raw: string): string {
  let s = raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s) {
    s = "skill";
  }
  return s.slice(0, 120);
}

function resolveArchiveTypeFromUrl(url: string): string | undefined {
  const lower = url.toLowerCase();
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (p.endsWith(".tar.gz") || p.endsWith(".tgz")) {
      return "tar.gz";
    }
    if (p.endsWith(".tar.bz2") || p.endsWith(".tbz2")) {
      return "tar.bz2";
    }
    if (p.endsWith(".zip")) {
      return "zip";
    }
  } catch {
    // ignore
  }
  if (lower.includes(".tar.gz") || lower.endsWith(".tgz")) {
    return "tar.gz";
  }
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  return undefined;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function hasSkillMd(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, "SKILL.md"));
}

/**
 * After extracting an archive to `outDir`, find the folder that contains SKILL.md
 * (either outDir itself or a single nested directory).
 */
async function resolveExtractedSkillRoot(outDir: string): Promise<string | null> {
  if (await hasSkillMd(outDir)) {
    return outDir;
  }
  const entries = await fs.readdir(outDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
  const candidates: string[] = [];
  for (const d of dirs) {
    const inner = path.join(outDir, d.name);
    if (await hasSkillMd(inner)) {
      candidates.push(inner);
    }
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  return null;
}

/**
 * Download a skill bundle (zip/tar.gz) from `url` into `<workspace>/skills/<skillDir>/`.
 * Used by the gateway `skills.download` RPC (e.g. desktop Skills store).
 */
export async function installSkillBundleFromUrl(params: {
  workspaceDir: string;
  skillName: string;
  url: string;
  timeoutMs: number;
  config: OpenClawConfig;
}): Promise<SkillInstallResult> {
  const timeoutMs = Math.min(Math.max(params.timeoutMs, 1_000), 900_000);
  const workspaceDir = resolveUserPath(params.workspaceDir);
  const url = params.url.trim();
  if (!url) {
    return { ok: false, message: "missing url", stdout: "", stderr: "", code: null };
  }

  const skillDirName = sanitizeSkillDirName(params.skillName);
  const skillsRoot = path.join(workspaceDir, "skills");
  const destDir = path.join(skillsRoot, skillDirName);

  if (await pathExists(destDir)) {
    const existing = await fs.readdir(destDir);
    if (existing.length > 0) {
      const workspaceName = path.basename(workspaceDir);
      return {
        ok: false,
        message: `Skill "${skillDirName}" already installed for this agent (workspace: ${workspaceName}). Choose a different skill or select another agent.`,
        stdout: "",
        stderr: "",
        code: null,
      };
    }
  }

  const archiveType = resolveArchiveTypeFromUrl(url);
  if (!archiveType) {
    return {
      ok: false,
      message: "Could not detect archive type from URL (expected .zip, .tar.gz, or .tgz)",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const stagingId = randomUUID();
  const staging = path.join(skillsRoot, `.openclaw-skill-dl-${stagingId}`);
  const outDir = path.join(staging, "out");
  const ext = archiveType === "zip" ? "zip" : archiveType === "tar.bz2" ? "tar.bz2" : "tgz";
  const archivePath = path.join(staging, `bundle.${ext}`);

  try {
    await ensureDir(staging);
    await ensureDir(outDir);

    const { response, release } = await fetchWithSsrFGuard({
      url,
      timeoutMs,
      policy: params.config.browser?.ssrfPolicy,
      auditContext: "skills.download",
    });
    try {
      if (!response.ok || !response.body) {
        return {
          ok: false,
          message: `Download failed (${response.status} ${response.statusText})`,
          stdout: "",
          stderr: "",
          code: null,
        };
      }
      const file = fsSync.createWriteStream(archivePath);
      const body = response.body as unknown;
      const readable = isNodeReadableStream(body)
        ? body
        : Readable.fromWeb(body as NodeReadableStream);
      await pipeline(readable, file);
    } finally {
      await release();
    }

    const extractResult = await extractArchive({
      archivePath,
      archiveType,
      targetDir: outDir,
      timeoutMs,
    });
    if (extractResult.code !== 0) {
      return {
        ok: false,
        message: extractResult.stderr || "Archive extract failed",
        stdout: extractResult.stdout,
        stderr: extractResult.stderr,
        code: extractResult.code,
      };
    }

    const skillRoot = await resolveExtractedSkillRoot(outDir);
    if (!skillRoot) {
      return {
        ok: false,
        message:
          "Archive layout not recognized: expected SKILL.md at bundle root or inside a single top-level folder",
        stdout: "",
        stderr: "",
        code: null,
      };
    }

    await ensureDir(skillsRoot);
    await fs.mkdir(destDir, { recursive: true });
    await fs.cp(skillRoot, destDir, { recursive: true });

    return {
      ok: true,
      message: `Installed skill into skills/${skillDirName}`,
      stdout: `skillDir=${skillDirName}`,
      stderr: "",
      code: 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, stdout: "", stderr: message, code: null };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
