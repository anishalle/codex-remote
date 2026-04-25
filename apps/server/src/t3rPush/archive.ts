import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import * as path from "node:path";

function execFileBuffer(command: string, args: ReadonlyArray<string>, cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(Buffer.from(stderr).toString("utf8") || error.message));
          return;
        }
        resolve(Buffer.from(stdout));
      },
    );
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function normalizeArchiveEntries(entries: ReadonlyArray<string>): readonly string[] {
  const unique = new Set<string>();
  for (const entry of entries) {
    if (entry.length === 0) {
      continue;
    }
    if (entry.includes("\0") || entry.includes("\n") || entry.includes("\r")) {
      throw new Error(
        `t3r push cannot archive a path containing control separators: ${JSON.stringify(entry)}`,
      );
    }
    unique.add(entry);
  }
  return [...unique];
}

async function collectGitArchiveEntries(workspaceRoot: string): Promise<readonly string[]> {
  const stdout = await execFileBuffer(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    workspaceRoot,
  );
  const entries = stdout
    .toString("utf8")
    .split("\u0000")
    .filter((entry) => entry.length > 0);
  const gitDirExists = await pathExists(path.join(workspaceRoot, ".git"));
  return normalizeArchiveEntries(gitDirExists ? [".git", ...entries] : entries);
}

export async function collectWorkspaceArchiveEntries(
  workspaceRoot: string,
): Promise<readonly string[]> {
  try {
    return await collectGitArchiveEntries(workspaceRoot);
  } catch {
    return ["."];
  }
}

export function serializeWorkspaceArchiveEntries(entries: ReadonlyArray<string>): string {
  const normalized = normalizeArchiveEntries(entries);
  return normalized.length > 0 ? `${normalized.join("\n")}\n` : "";
}
