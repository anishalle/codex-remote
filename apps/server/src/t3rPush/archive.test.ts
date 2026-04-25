import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  collectWorkspaceArchiveEntries,
  serializeWorkspaceArchiveEntries,
} from "./archive.ts";

function execGit(cwd: string, args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve();
    });
  });
}

describe("t3r push archive selection", () => {
  it("archives git-visible files and excludes ignored workspace bulk", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "t3r-archive-test-"));
    await execGit(workspaceRoot, ["init"]);
    await fs.writeFile(path.join(workspaceRoot, ".gitignore"), "node_modules/\n*.log\n", "utf8");
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "index.ts"), "export const ok = true;\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "notes.txt"), "keep me\n", "utf8");
    await fs.mkdir(path.join(workspaceRoot, "node_modules", "left-pad"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "node_modules", "left-pad", "index.js"),
      "module.exports = 1;\n",
      "utf8",
    );
    await fs.writeFile(path.join(workspaceRoot, "debug.log"), "ignore me\n", "utf8");
    await execGit(workspaceRoot, ["add", ".gitignore", "src/index.ts"]);

    const entries = await collectWorkspaceArchiveEntries(workspaceRoot);

    expect(entries).toContain(".git");
    expect(entries).toContain(".gitignore");
    expect(entries).toContain("src/index.ts");
    expect(entries).toContain("notes.txt");
    expect(entries).not.toContain("node_modules/left-pad/index.js");
    expect(entries).not.toContain("debug.log");
    expect(serializeWorkspaceArchiveEntries(entries)).toContain("src/index.ts\n");
  });

  it("falls back to archiving the full directory for non-git workspaces", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "t3r-archive-fallback-"));

    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# hello\n", "utf8");

    const entries = await collectWorkspaceArchiveEntries(workspaceRoot);

    expect(entries).toEqual(["."]);
    expect(serializeWorkspaceArchiveEntries(entries)).toBe(".\n");
  });
});
