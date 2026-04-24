import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export const CONFIG_VERSION = 1;

export interface ProjectConfig {
  readonly name: string;
  readonly path: string;
  readonly addedAt: string;
}

export interface MacRunnerConfig {
  readonly version: typeof CONFIG_VERSION;
  readonly serverUrl?: string;
  readonly sessionToken?: string;
  readonly sessionId?: string;
  readonly deviceId?: string;
  readonly deviceName: string;
  readonly runnerId: string;
  readonly runnerName: string;
  readonly webSocketOrigin?: string;
  readonly projects: Record<string, ProjectConfig>;
}

export interface ConfigPaths {
  readonly homeDir: string;
  readonly configPath: string;
  readonly stateDbPath: string;
}

export function getCloudCodexPaths(env: NodeJS.ProcessEnv = process.env): ConfigPaths {
  const homeDir = env.CLOUD_CODEX_HOME?.trim() || join(homedir(), ".cloudcodex");
  return {
    homeDir,
    configPath: join(homeDir, "config.json"),
    stateDbPath: join(homeDir, "state.db"),
  };
}

export function ensureCloudCodexHome(paths = getCloudCodexPaths()): void {
  mkdirSync(paths.homeDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.homeDir, 0o700);
}

export function defaultConfig(): MacRunnerConfig {
  const host = hostname() || "mac-runner";
  return {
    version: CONFIG_VERSION,
    deviceName: host,
    runnerId: `runner_${randomUUID()}`,
    runnerName: host,
    projects: {},
  };
}

export function loadConfig(paths = getCloudCodexPaths()): MacRunnerConfig {
  ensureCloudCodexHome(paths);
  if (!existsSync(paths.configPath)) {
    return defaultConfig();
  }
  const parsed = JSON.parse(readFileSync(paths.configPath, "utf8")) as Partial<MacRunnerConfig>;
  return normalizeConfig(parsed);
}

export function saveConfig(config: MacRunnerConfig, paths = getCloudCodexPaths()): void {
  ensureCloudCodexHome(paths);
  const tmpPath = `${paths.configPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, paths.configPath);
  chmodSync(paths.configPath, 0o600);
}

export function normalizeServerUrl(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error("server-url is required.");
  }
  const url = new URL(value);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("server-url must use https://, http://, wss://, or ws://.");
  }
  if (url.protocol === "http:" && !isLocalhost(url.hostname)) {
    throw new Error("Plain http:// is only allowed for localhost development.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function toRunnerWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws/runner`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function addProject(
  config: MacRunnerConfig,
  input: { readonly name: string; readonly path: string },
): MacRunnerConfig {
  const name = input.name.trim();
  if (!name) {
    throw new Error("--name is required.");
  }
  const workspaceRoot = realpathSync(resolve(input.path));
  if (!statSync(workspaceRoot).isDirectory()) {
    throw new Error("Project path must be a directory.");
  }
  return {
    ...config,
    projects: {
      ...config.projects,
      [name]: {
        name,
        path: workspaceRoot,
        addedAt: new Date().toISOString(),
      },
    },
  };
}

export function requireServerUrl(config: MacRunnerConfig): string {
  if (!config.serverUrl) {
    throw new Error("Run cloudcodex login <server-url> first.");
  }
  return config.serverUrl;
}

export function requireSessionToken(config: MacRunnerConfig): string {
  if (!config.sessionToken) {
    throw new Error("Run cloudcodex pair first.");
  }
  return config.sessionToken;
}

export function requireProject(config: MacRunnerConfig, projectName: string): ProjectConfig {
  const project = config.projects[projectName];
  if (!project) {
    throw new Error(`Unknown project "${projectName}". Run cloudcodex project add first.`);
  }
  return project;
}

export function validateRegisteredProject(
  config: MacRunnerConfig,
  projectName: string,
): ProjectConfig {
  const project = requireProject(config, projectName);
  const currentRoot = realpathSync(project.path);
  if (currentRoot !== project.path) {
    throw new Error(`Project "${projectName}" no longer resolves to its registered root.`);
  }
  if (!statSync(currentRoot).isDirectory()) {
    throw new Error(`Project "${projectName}" is not a directory.`);
  }
  return project;
}

function normalizeConfig(input: Partial<MacRunnerConfig>): MacRunnerConfig {
  const fallback = defaultConfig();
  const projects =
    input.projects && typeof input.projects === "object" && !Array.isArray(input.projects)
      ? input.projects
      : {};
  return {
    version: CONFIG_VERSION,
    serverUrl: typeof input.serverUrl === "string" ? input.serverUrl : undefined,
    sessionToken: typeof input.sessionToken === "string" ? input.sessionToken : undefined,
    sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined,
    deviceId: typeof input.deviceId === "string" ? input.deviceId : undefined,
    deviceName:
      typeof input.deviceName === "string" && input.deviceName.trim()
        ? input.deviceName.trim()
        : fallback.deviceName,
    runnerId:
      typeof input.runnerId === "string" && input.runnerId.trim()
        ? input.runnerId.trim()
        : fallback.runnerId,
    runnerName:
      typeof input.runnerName === "string" && input.runnerName.trim()
        ? input.runnerName.trim()
        : fallback.runnerName,
    webSocketOrigin:
      typeof input.webSocketOrigin === "string" && input.webSocketOrigin.trim()
        ? input.webSocketOrigin.trim()
        : undefined,
    projects,
  };
}

function isLocalhost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
