import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { assertAllowedPath, inspectHandoffPackage } from "../../../packages/workspace-packager/src/index.ts";
import type { ProjectConfig } from "../../mac-runner-cli/src/config.ts";
import type { CloudRunnerConfig } from "./config.ts";
import { requireSessionToken } from "./config.ts";
import {
  assertPathInsideProject,
  createCloudProject,
  resolveCloudProjectPath,
  validateProjectId,
} from "./path-guard.ts";

export async function unpackHandoffWorkspace(input: {
  readonly config: CloudRunnerConfig;
  readonly uploadId: string;
  readonly projectId: string;
}): Promise<ProjectConfig> {
  const projectId = validateProjectId(input.projectId);
  const raw = await downloadHandoffPackage(input.config, input.uploadId);
  const inspected = inspectHandoffPackage(raw);
  const targetPath = resolveCloudProjectPath({
    workspacesRoot: input.config.workspacesRoot,
    projectId,
  });
  if (existsSync(targetPath) && readdirSync(targetPath).length > 0) {
    throw new Error(`Cloud project ${projectId} already exists and is not empty.`);
  }

  const tmp = mkdtempSync(join(tmpdir(), "cloudcodex-unpack-"));
  try {
    const bundlePath = join(tmp, "workspace.bundle");
    writeFileSync(bundlePath, Buffer.from(inspected.handoffPackage.gitBundleBase64, "base64"), {
      mode: 0o600,
    });
    execFileSync("git", ["bundle", "verify", bundlePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync("git", ["clone", bundlePath, targetPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    for (const overlay of inspected.handoffPackage.overlayFiles) {
      assertAllowedPath(overlay.path);
      const target = assertPathInsideProject({
        projectRoot: targetPath,
        targetPath: overlay.path,
      });
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
        throw new Error(`Refusing to write overlay through symlink: ${overlay.path}`);
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, Buffer.from(overlay.contentBase64, "base64"), {
        mode: overlay.mode,
      });
      chmodSync(target, overlay.mode);
    }

    const project = createCloudProject({
      workspacesRoot: input.config.workspacesRoot,
      projectId,
      name: inspected.handoffPackage.manifest.source.workspaceName,
    });
    return {
      name: project.projectId,
      path: project.path,
      addedAt: project.addedAt,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function downloadHandoffPackage(config: CloudRunnerConfig, uploadId: string): Promise<string> {
  const url = new URL(`/api/uploads/${encodeURIComponent(uploadId)}/package`, config.serverUrl);
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${requireSessionToken(config)}`,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to download handoff package: HTTP ${response.status} ${body}`);
  }
  return response.text();
}
