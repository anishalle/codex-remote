import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

export const DEFAULT_WORKSPACES_ROOT = "/workspaces";
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export interface CloudProject {
  readonly projectId: string;
  readonly name: string;
  readonly path: string;
  readonly addedAt: string;
}

export class WorkspaceBoundaryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceBoundaryError";
    this.code = code;
  }
}

export function validateProjectId(projectId: string): string {
  const normalized = projectId.trim();
  if (!PROJECT_ID_PATTERN.test(normalized)) {
    throw new WorkspaceBoundaryError(
      "project_id_invalid",
      "Project id must be 1-80 chars and contain only letters, numbers, dot, underscore, or dash.",
    );
  }
  if (normalized === "." || normalized === ".." || normalized.includes("..")) {
    throw new WorkspaceBoundaryError(
      "project_id_invalid",
      "Project id may not contain path traversal segments.",
    );
  }
  return normalized;
}

export function ensureWorkspacesRoot(workspacesRoot = DEFAULT_WORKSPACES_ROOT): string {
  mkdirSync(workspacesRoot, { recursive: true, mode: 0o700 });
  chmodSync(workspacesRoot, 0o700);
  const realRoot = realpathSync(workspacesRoot);
  const stat = statSync(realRoot);
  if (!stat.isDirectory()) {
    throw new WorkspaceBoundaryError("workspace_root_invalid", "Workspaces root is not a directory.");
  }
  return realRoot;
}

export function resolveCloudProjectPath(input: {
  readonly workspacesRoot?: string;
  readonly projectId: string;
  readonly mustExist?: boolean;
}): string {
  const root = ensureWorkspacesRoot(input.workspacesRoot);
  const projectId = validateProjectId(input.projectId);
  const candidate = resolve(root, projectId);
  assertInside(root, candidate);

  if (!existsSync(candidate)) {
    if (input.mustExist) {
      throw new WorkspaceBoundaryError("project_missing", `Cloud project ${projectId} does not exist.`);
    }
    return candidate;
  }

  const realCandidate = realpathSync(candidate);
  assertInside(root, realCandidate);
  if (!statSync(realCandidate).isDirectory()) {
    throw new WorkspaceBoundaryError("project_not_directory", "Cloud project path is not a directory.");
  }
  return realCandidate;
}

export function assertPathInsideProject(input: {
  readonly projectRoot: string;
  readonly targetPath: string;
}): string {
  const projectRoot = realpathSync(input.projectRoot);
  const target = resolve(projectRoot, input.targetPath);
  assertInside(projectRoot, target);

  if (existsSync(target)) {
    const realTarget = realpathSync(target);
    assertInside(projectRoot, realTarget);
    return realTarget;
  }

  const realParent = nearestExistingParent(target);
  assertInside(projectRoot, realParent);
  return target;
}

export function createCloudProject(input: {
  readonly workspacesRoot?: string;
  readonly projectId: string;
  readonly name?: string;
  readonly now?: string;
}): CloudProject {
  const projectId = validateProjectId(input.projectId);
  const path = resolveCloudProjectPath({
    workspacesRoot: input.workspacesRoot,
    projectId,
  });
  const addedAt = input.now ?? new Date().toISOString();
  if (!existsSync(path)) {
    mkdirSync(path, { mode: 0o700 });
  }
  chmodSync(path, 0o700);
  const realPath = resolveCloudProjectPath({
    workspacesRoot: input.workspacesRoot,
    projectId,
    mustExist: true,
  });
  const project: CloudProject = {
    projectId,
    name: input.name?.trim() || projectId,
    path: realPath,
    addedAt,
  };
  writeProjectManifest(project);
  return project;
}

export function listCloudProjects(workspacesRoot = DEFAULT_WORKSPACES_ROOT): CloudProject[] {
  const root = ensureWorkspacesRoot(workspacesRoot);
  const projects: CloudProject[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const projectId = validateProjectId(entry.name);
      const path = resolveCloudProjectPath({
        workspacesRoot: root,
        projectId,
        mustExist: true,
      });
      projects.push(readProjectManifest(projectId, path));
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError) continue;
      throw error;
    }
  }
  return projects.sort((left, right) => left.projectId.localeCompare(right.projectId));
}

function writeProjectManifest(project: CloudProject): void {
  const manifestPath = join(project.path, ".cloudcodex-project.json");
  if (existsSync(manifestPath) && lstatSync(manifestPath).isSymbolicLink()) {
    throw new WorkspaceBoundaryError(
      "project_manifest_symlink",
      "Refusing to write project manifest through a symlink.",
    );
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        projectId: project.projectId,
        name: project.name,
        addedAt: project.addedAt,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(manifestPath, 0o600);
}

function readProjectManifest(projectId: string, path: string): CloudProject {
  const manifestPath = join(path, ".cloudcodex-project.json");
  if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) {
    return {
      projectId,
      name: projectId,
      path,
      addedAt: statSync(path).birthtime.toISOString(),
    };
  }
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<CloudProject>;
  return {
    projectId,
    name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : projectId,
    path,
    addedAt:
      typeof parsed.addedAt === "string" && parsed.addedAt.trim()
        ? parsed.addedAt.trim()
        : statSync(path).birthtime.toISOString(),
  };
}

function nearestExistingParent(targetPath: string): string {
  let current = targetPath;
  while (!existsSync(current)) {
    const next = resolve(current, "..");
    if (next === current) {
      throw new WorkspaceBoundaryError("path_missing", "No existing parent found for path.");
    }
    current = next;
  }
  return realpathSync(current);
}

function assertInside(root: string, candidate: string): void {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(normalizedRoot)) {
    throw new WorkspaceBoundaryError(
      "workspace_boundary_violation",
      "Path escapes the registered workspace root.",
    );
  }
}
