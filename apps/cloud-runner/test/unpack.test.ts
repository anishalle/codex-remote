import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHandoffPackage } from "../../../packages/workspace-packager/src/index.ts";
import type { CloudRunnerConfig } from "../src/config.ts";
import { unpackHandoffWorkspace } from "../src/unpack.ts";

function tempDir(t: test.TestContext, prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function makeRepo(t: test.TestContext): { readonly root: string; readonly packagePath: string } {
  const root = tempDir(t, "cloud-runner-unpack-repo-");
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
  writeFileSync(join(root, "README.md"), "tracked\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root });
  writeFileSync(join(root, "notes.txt"), "approved overlay\n");
  const packagePath = join(root, "handoff.json");
  createHandoffPackage({
    workspaceRoot: root,
    outputPath: packagePath,
    includeUntracked: ["notes.txt"],
    summary: "Continue from test.",
  });
  return { root, packagePath };
}

test("unpacks a validated handoff package into a cloud workspace", async (t) => {
  const { packagePath } = makeRepo(t);
  const workspacesRoot = tempDir(t, "cloud-runner-unpack-workspaces-");
  const runnerHome = tempDir(t, "cloud-runner-unpack-home-");
  const codexHome = tempDir(t, "cloud-runner-unpack-codex-");
  const token = "ccs_test";
  const server = createServer((req, res) => {
    if (
      req.url === "/api/uploads/upload-test/package" &&
      req.headers.authorization === `Bearer ${token}`
    ) {
      const raw = readFileSync(packagePath);
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": raw.byteLength,
      });
      res.end(raw);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(() => server.close());
  const baseUrl = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  const config: CloudRunnerConfig = {
    serverUrl: baseUrl,
    sessionToken: token,
    sessionTokenPath: join(runnerHome, "session.token"),
    runnerId: "cloud-runner-test",
    runnerName: "cloud runner test",
    runnerHome,
    stateDbPath: join(runnerHome, "state.db"),
    workspacesRoot,
    codexHome,
  };
  const project = await unpackHandoffWorkspace({
    config,
    uploadId: "upload-test",
    projectId: "cloud-repo",
  });

  assert.equal(project.name, "cloud-repo");
  assert.equal(readFileSync(join(project.path, "README.md"), "utf8"), "tracked\n");
  assert.equal(readFileSync(join(project.path, "notes.txt"), "utf8"), "approved overlay\n");
});
