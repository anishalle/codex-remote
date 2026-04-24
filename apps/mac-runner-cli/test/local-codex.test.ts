import assert from "node:assert/strict";
import test from "node:test";

import { createCodexSandboxPolicy } from "../src/local-codex.ts";

test("workspace-write sandbox is constrained to the registered project", () => {
  assert.deepEqual(
    createCodexSandboxPolicy({
      projectPath: "/workspaces/project",
    }),
    {
      type: "workspaceWrite",
      writableRoots: ["/workspaces/project"],
      readOnlyAccess: {
        type: "restricted",
        includePlatformDefaults: true,
        readableRoots: ["/workspaces/project"],
      },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  );
});

test("read-only sandbox keeps network disabled by default", () => {
  assert.deepEqual(
    createCodexSandboxPolicy({
      projectPath: "/workspaces/project",
      mode: "read-only",
    }),
    {
      type: "readOnly",
      access: {
        type: "restricted",
        includePlatformDefaults: true,
        readableRoots: ["/workspaces/project"],
      },
      networkAccess: false,
    },
  );
});
