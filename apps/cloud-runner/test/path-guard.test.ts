import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WorkspaceBoundaryError,
  assertPathInsideProject,
  createCloudProject,
  deleteCloudProject,
  listCloudProjects,
  resolveCloudProjectPath,
  validateProjectId,
} from "../src/path-guard.ts";

function tempRoot(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "cloud-runner-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("cloud projects are direct children of the workspaces root", (t) => {
  const root = tempRoot(t);
  const project = createCloudProject({
    workspacesRoot: root,
    projectId: "repo-one",
    now: "2026-04-24T00:00:00.000Z",
  });

  assert.equal(project.projectId, "repo-one");
  assert.equal(project.path, join(realpathSync(root), "repo-one"));
  assert.deepEqual(
    listCloudProjects(root).map((entry) => entry.projectId),
    ["repo-one"],
  );
});

test("cloud projects can be deleted within the workspaces root", (t) => {
  const root = tempRoot(t);
  const project = createCloudProject({ workspacesRoot: root, projectId: "repo-delete" });

  deleteCloudProject({ workspacesRoot: root, projectId: "repo-delete" });

  assert.equal(existsSync(project.path), false);
  assert.deepEqual(listCloudProjects(root), []);
});

test("project ids reject traversal and path separators", () => {
  for (const value of ["../escape", "escape/path", "/escape", ".hidden", "a..b", ""]) {
    assert.throws(() => validateProjectId(value), WorkspaceBoundaryError);
  }
  assert.equal(validateProjectId("safe_repo-1.2"), "safe_repo-1.2");
});

test("existing symlink projects cannot escape the workspaces root", (t) => {
  const root = tempRoot(t);
  const outside = mkdtempSync(join(tmpdir(), "cloud-runner-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(root, "escape"), "dir");

  assert.throws(
    () =>
      resolveCloudProjectPath({
        workspacesRoot: root,
        projectId: "escape",
        mustExist: true,
      }),
    WorkspaceBoundaryError,
  );
});

test("file paths are constrained to the selected cloud project", (t) => {
  const root = tempRoot(t);
  const project = createCloudProject({ workspacesRoot: root, projectId: "repo" });
  writeFileSync(join(project.path, "README.md"), "ok\n");

  assert.equal(
    assertPathInsideProject({
      projectRoot: project.path,
      targetPath: "README.md",
    }),
    join(project.path, "README.md"),
  );
  assert.throws(
    () =>
      assertPathInsideProject({
        projectRoot: project.path,
        targetPath: "../outside",
      }),
    WorkspaceBoundaryError,
  );
});
