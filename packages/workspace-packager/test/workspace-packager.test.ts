import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WorkspaceGuardError,
  createHandoffPackage,
  inspectHandoffPackage,
  validateHandoffManifest,
} from "../src/index.ts";

function tempRepo(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "workspace-packager-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
  writeFileSync(join(root, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root });
  return root;
}

test("creates and validates a git-bundle handoff package with approved untracked overlay", (t) => {
  const root = tempRepo(t);
  writeFileSync(join(root, "notes.txt"), "safe notes\n");
  const outputPath = join(root, "handoff.json");

  const created = createHandoffPackage({
    workspaceRoot: root,
    outputPath,
    includeUntracked: ["notes.txt"],
    localThreadId: "thread-local",
    exportedEventCount: 2,
    summary: "Continue the implementation.",
  });
  const inspected = inspectHandoffPackage(readFileSync(outputPath, "utf8"));

  assert.equal(created.manifest.overlay.files.length, 1);
  assert.equal(inspected.handoffPackage.manifest.conversation.localThreadId, "thread-local");
  assert.equal(inspected.handoffPackage.overlayFiles[0].path, "notes.txt");
  assert.equal(validateHandoffManifest(created.manifest).bundle.mode, "git-bundle");
});

test("denylisted overlay paths are refused", (t) => {
  const root = tempRepo(t);
  writeFileSync(join(root, ".env"), "TOKEN=not-for-cloud\n");
  assert.throws(
    () =>
      createHandoffPackage({
        workspaceRoot: root,
        outputPath: join(root, "handoff.json"),
        includeUntracked: [".env"],
      }),
    WorkspaceGuardError,
  );
});

test("secret-looking overlay contents are refused", (t) => {
  const root = tempRepo(t);
  writeFileSync(join(root, "notes.txt"), "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz\n");
  assert.throws(
    () =>
      createHandoffPackage({
        workspaceRoot: root,
        outputPath: join(root, "handoff.json"),
        includeUntracked: ["notes.txt"],
      }),
    /Potential secrets detected/,
  );
});
