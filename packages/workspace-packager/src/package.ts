import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

import {
  HANDOFF_MANIFEST_VERSION,
  HANDOFF_PACKAGE_KIND,
  validateHandoffPackage,
  type HandoffManifest,
  type HandoffPackage,
  type OverlayFile,
} from "./manifest.ts";
import {
  assertAllowedPath,
  assertInsideWorkspace,
  assertNoSecretFindings,
  relativeToWorkspace,
  safeFileMode,
  scanBufferForSecrets,
} from "./guards.ts";
import { generateHandoffPrompt } from "./prompt.ts";

export interface CreateHandoffPackageInput {
  readonly workspaceRoot?: string;
  readonly outputPath: string;
  readonly includeUntracked?: readonly string[];
  readonly localThreadId?: string;
  readonly exportedEventCount?: number;
  readonly summary?: string;
  readonly userInstruction?: string;
}

export interface CreateHandoffPackageResult {
  readonly packagePath: string;
  readonly manifest: HandoffManifest;
  readonly bytes: number;
  readonly sha256: string;
}

export function createHandoffPackage(input: CreateHandoffPackageInput): CreateHandoffPackageResult {
  const workspaceRoot = input.workspaceRoot ? realGitRootOrPath(input.workspaceRoot) : gitRoot(process.cwd());
  const dirtyTracked = trackedDirtyPaths(workspaceRoot);
  if (dirtyTracked.length > 0) {
    throw new Error(
      `Refusing to hand off dirty tracked files. Commit or stash first: ${dirtyTracked.join(", ")}`,
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), "cloudcodex-handoff-"));
  try {
    const bundlePath = join(tmp, "workspace.bundle");
    execFileSync("git", ["bundle", "create", bundlePath, "HEAD"], {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const bundle = readFileSync(bundlePath);
    const gitHead = execGit(workspaceRoot, ["rev-parse", "HEAD"]).trim();
    const gitBranch = execGit(workspaceRoot, ["branch", "--show-current"]).trim();
    const overlayFiles = buildOverlayFiles(workspaceRoot, input.includeUntracked ?? []);
    const manifest: HandoffManifest = {
      version: HANDOFF_MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      source: {
        workspaceName: basename(workspaceRoot),
        gitHead,
        ...(gitBranch ? { gitBranch } : {}),
        dirtyTracked,
      },
      bundle: {
        mode: "git-bundle",
        sha256: sha256(bundle),
        bytes: bundle.byteLength,
      },
      overlay: {
        mode: "approved-untracked",
        files: overlayFiles.map(({ contentBase64, ...file }) => file),
      },
      conversation: {
        ...(input.localThreadId ? { localThreadId: input.localThreadId } : {}),
        exportedEventCount: input.exportedEventCount ?? 0,
        summary: input.summary?.trim() || "No handoff summary was provided.",
      },
    };
    const handoffPackage: HandoffPackage = {
      kind: HANDOFF_PACKAGE_KIND,
      manifest,
      gitBundleBase64: bundle.toString("base64"),
      overlayFiles,
      handoffPrompt: generateHandoffPrompt({
        manifest,
        summary: input.summary,
        userInstruction: input.userInstruction,
      }),
    };
    validateHandoffPackage(handoffPackage);
    const raw = `${JSON.stringify(handoffPackage)}\n`;
    writeFileSync(input.outputPath, raw, { mode: 0o600 });
    chmodSync(input.outputPath, 0o600);
    const bytes = statSync(input.outputPath).size;
    return {
      packagePath: input.outputPath,
      manifest,
      bytes,
      sha256: sha256(Buffer.from(raw)),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function inspectHandoffPackage(raw: string): {
  readonly handoffPackage: HandoffPackage;
  readonly packageSha256: string;
  readonly packageBytes: number;
} {
  const handoffPackage = validateHandoffPackage(JSON.parse(raw));
  const bundle = Buffer.from(handoffPackage.gitBundleBase64, "base64");
  if (sha256(bundle) !== handoffPackage.manifest.bundle.sha256) {
    throw new Error("Git bundle sha256 does not match manifest.");
  }
  if (bundle.byteLength !== handoffPackage.manifest.bundle.bytes) {
    throw new Error("Git bundle size does not match manifest.");
  }
  verifyGitBundle(bundle);
  for (const overlay of handoffPackage.overlayFiles) {
    const content = Buffer.from(overlay.contentBase64, "base64");
    if (sha256(content) !== overlay.sha256 || content.byteLength !== overlay.bytes) {
      throw new Error(`Overlay file ${overlay.path} does not match manifest.`);
    }
    assertAllowedPath(overlay.path);
    assertNoSecretFindings(scanBufferForSecrets(overlay.path, content));
  }
  return {
    handoffPackage,
    packageSha256: sha256(Buffer.from(raw)),
    packageBytes: Buffer.byteLength(raw),
  };
}

function verifyGitBundle(bundle: Buffer): void {
  const tmp = mkdtempSync(join(tmpdir(), "cloudcodex-verify-bundle-"));
  try {
    const bundlePath = join(tmp, "workspace.bundle");
    writeFileSync(bundlePath, bundle, { mode: 0o600 });
    execFileSync("git", ["init"], {
      cwd: tmp,
      stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync("git", ["bundle", "verify", bundlePath], {
      cwd: tmp,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function redactedManifest(manifest: HandoffManifest): HandoffManifest {
  return {
    ...manifest,
    conversation: {
      ...manifest.conversation,
      summary: redactText(manifest.conversation.summary),
    },
  };
}

function buildOverlayFiles(workspaceRoot: string, requested: readonly string[]): readonly OverlayFile[] {
  const files: OverlayFile[] = [];
  for (const requestedPath of requested) {
    const path = requestedPath.replaceAll("\\", "/");
    assertAllowedPath(path);
    const absolute = assertInsideWorkspace({
      workspaceRoot,
      relativePath: path,
      mustExist: true,
    });
    const status = gitStatusForPath(workspaceRoot, path);
    if (status !== "untracked") {
      throw new Error(`Overlay path must be untracked and explicitly approved: ${path}`);
    }
    const stat = statSync(absolute);
    if (!stat.isFile()) {
      throw new Error(`Overlay path must be a regular file: ${path}`);
    }
    const content = readFileSync(absolute);
    assertNoSecretFindings(scanBufferForSecrets(path, content));
    files.push({
      path: relativeToWorkspace(workspaceRoot, absolute),
      sha256: sha256(content),
      bytes: content.byteLength,
      mode: safeFileMode(stat.mode),
      contentBase64: content.toString("base64"),
    });
  }
  return files;
}

function gitStatusForPath(workspaceRoot: string, path: string): "untracked" | "tracked" | "missing" {
  const status = execGit(workspaceRoot, ["status", "--porcelain=v1", "--", path]);
  if (!status.trim()) return "tracked";
  if (status.split("\n").some((line) => line.startsWith("?? "))) return "untracked";
  return "tracked";
}

function trackedDirtyPaths(workspaceRoot: string): readonly string[] {
  return execGit(workspaceRoot, ["status", "--porcelain=v1"])
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith("?? "))
    .map((line) => line.slice(3));
}

function realGitRootOrPath(path: string): string {
  try {
    return gitRoot(path);
  } catch {
    return path;
  }
}

function gitRoot(cwd: string): string {
  return execGit(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

function execGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function redactText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{8,}\b/g, "gh_[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]");
}
