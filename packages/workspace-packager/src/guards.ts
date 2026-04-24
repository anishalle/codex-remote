import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { ManifestValidationError, validateRelativePath } from "./manifest.ts";

export const DEFAULT_DENYLIST_PATTERNS = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".ssh/**",
  "**/.ssh/**",
  "id_rsa",
  "id_ed25519",
  "**/id_rsa",
  "**/id_ed25519",
  ".aws/credentials",
  ".aws/config",
  "**/.aws/credentials",
  "**/.aws/config",
  ".config/gcloud/**",
  "**/.config/gcloud/**",
  ".kube/config",
  "**/.kube/config",
  ".npmrc",
  "**/.npmrc",
  ".pypirc",
  "**/.pypirc",
  ".netrc",
  "**/.netrc",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keychain",
  "*.keychain-db",
] as const;

const SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/ },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: "assignment-secret",
    pattern: /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*['"]?[^'"\s]{12,}/i,
  },
];

export class WorkspaceGuardError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceGuardError";
    this.code = code;
  }
}

export interface ScanFinding {
  readonly path: string;
  readonly reason: string;
}

export function assertInsideWorkspace(input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly mustExist?: boolean;
}): string {
  const root = realpathSync(input.workspaceRoot);
  const safeRelative = validateRelativePath(input.relativePath);
  const candidate = resolve(root, safeRelative);
  assertInside(root, candidate);
  if (!existsSync(candidate)) {
    if (input.mustExist) {
      throw new WorkspaceGuardError("path_missing", `Path ${safeRelative} does not exist.`);
    }
    const parent = nearestExistingParent(candidate);
    assertInside(root, parent);
    return candidate;
  }
  if (lstatSync(candidate).isSymbolicLink()) {
    throw new WorkspaceGuardError("symlink_denied", `Refusing to package symlink ${safeRelative}.`);
  }
  const realCandidate = realpathSync(candidate);
  assertInside(root, realCandidate);
  return realCandidate;
}

export function relativeToWorkspace(workspaceRoot: string, path: string): string {
  return validateRelativePath(relative(realpathSync(workspaceRoot), realpathSync(path)).replaceAll("\\", "/"));
}

export function assertAllowedPath(path: string): void {
  const normalized = validateRelativePath(path);
  for (const pattern of DEFAULT_DENYLIST_PATTERNS) {
    if (globMatch(pattern, normalized)) {
      throw new WorkspaceGuardError("path_denylisted", `Refusing denylisted path ${normalized}.`);
    }
  }
}

export function scanBufferForSecrets(path: string, content: Buffer): readonly ScanFinding[] {
  const findings: ScanFinding[] = [];
  const text = content.toString("utf8");
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.pattern.test(text)) {
      findings.push({ path, reason: pattern.name });
    }
  }
  return findings;
}

export function assertNoSecretFindings(findings: readonly ScanFinding[]): void {
  if (findings.length === 0) return;
  const summary = findings.map((finding) => `${finding.path}:${finding.reason}`).join(", ");
  throw new WorkspaceGuardError("secret_scan_failed", `Potential secrets detected: ${summary}`);
}

export function safeFileMode(mode: number): number {
  return mode & 0o111 ? 0o755 : 0o644;
}

function nearestExistingParent(targetPath: string): string {
  let current = targetPath;
  while (!existsSync(current)) {
    const next = resolve(current, "..");
    if (next === current) {
      throw new WorkspaceGuardError("path_missing", "No existing parent found for path.");
    }
    current = next;
  }
  return realpathSync(current);
}

function assertInside(root: string, candidate: string): void {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(normalizedRoot)) {
    throw new WorkspaceGuardError("workspace_escape", "Path escapes the workspace root.");
  }
}

function globMatch(pattern: string, path: string): boolean {
  if (pattern.startsWith("**/")) {
    const suffix = pattern.slice(3);
    return globMatch(suffix, path) || path.endsWith(`/${suffix.replace(/\/\*\*$/, "")}`);
  }
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`) || path.includes(`/${prefix}/`);
  }
  if (pattern.includes("*")) {
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    return new RegExp(`^${escaped}$`).test(path);
  }
  return path === pattern || path.endsWith(`/${pattern}`);
}
