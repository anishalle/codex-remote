import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import {
  type MacRunnerConfig,
  type ProjectConfig,
} from "../../mac-runner-cli/src/config.ts";
import type { CloudProject } from "./path-guard.ts";
import { DEFAULT_WORKSPACES_ROOT } from "./path-guard.ts";

export const CLOUD_RUNNER_VERSION = "0.1.0";

export interface CloudRunnerConfig {
  readonly serverUrl: string;
  readonly sessionToken?: string;
  readonly sessionTokenPath: string;
  readonly runnerId: string;
  readonly runnerName: string;
  readonly runnerHome: string;
  readonly stateDbPath: string;
  readonly workspacesRoot: string;
  readonly codexHome: string;
  readonly codexBinary?: string;
  readonly webSocketOrigin?: string;
}

export function loadCloudRunnerConfig(env: NodeJS.ProcessEnv = process.env): CloudRunnerConfig {
  const runnerHome = resolve(env.CLOUD_CODEX_RUNNER_HOME?.trim() || "/cloudcodex");
  const tokenPath = resolve(
    env.CLOUD_CODEX_SESSION_TOKEN_FILE?.trim() || join(runnerHome, "session.token"),
  );
  const rawServerUrl = env.CLOUD_CODEX_SERVER_URL?.trim();
  if (!rawServerUrl) {
    throw new Error("CLOUD_CODEX_SERVER_URL must be set.");
  }
  return {
    serverUrl: normalizeCloudRunnerServerUrl(rawServerUrl, {
      allowInsecureHttp: env.CLOUD_CODEX_ALLOW_INSECURE_HTTP === "1",
    }),
    sessionToken: readSessionToken(env, tokenPath),
    sessionTokenPath: tokenPath,
    runnerId: env.CLOUD_CODEX_RUNNER_ID?.trim() || `cloud_runner_${hostname() || "vps"}`,
    runnerName: env.CLOUD_CODEX_RUNNER_NAME?.trim() || hostname() || "cloud-runner",
    runnerHome,
    stateDbPath: resolve(env.CLOUD_CODEX_STATE_DB_PATH?.trim() || join(runnerHome, "state.db")),
    workspacesRoot: resolve(
      env.CLOUD_CODEX_WORKSPACES_ROOT?.trim() || DEFAULT_WORKSPACES_ROOT,
    ),
    codexHome: resolve(env.CODEX_HOME?.trim() || env.CLOUD_CODEX_CODEX_HOME?.trim() || "/codex-home"),
    codexBinary: env.CLOUD_CODEX_CODEX_BINARY?.trim() || undefined,
    webSocketOrigin: env.CLOUD_CODEX_WS_ORIGIN?.trim() || undefined,
  };
}

export function normalizeCloudRunnerServerUrl(
  raw: string,
  options: { readonly allowInsecureHttp?: boolean } = {},
): string {
  const value = raw.trim();
  if (!value) {
    throw new Error("CLOUD_CODEX_SERVER_URL must be set.");
  }
  const url = new URL(value);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CLOUD_CODEX_SERVER_URL must use https://, http://, wss://, or ws://.");
  }
  if (url.protocol === "http:" && !options.allowInsecureHttp && !isLocalhost(url.hostname)) {
    throw new Error(
      "Plain http:// is only allowed for localhost unless CLOUD_CODEX_ALLOW_INSECURE_HTTP=1 is set.",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function ensureCloudRunnerHome(config: CloudRunnerConfig): void {
  mkdirSync(config.runnerHome, { recursive: true, mode: 0o700 });
  chmodSync(config.runnerHome, 0o700);
  mkdirSync(config.codexHome, { recursive: true, mode: 0o700 });
  chmodSync(config.codexHome, 0o700);
}

export function requireSessionToken(config: CloudRunnerConfig): string {
  if (!config.sessionToken) {
    throw new Error(
      `No runner session token found. Run "cloudcodex-cloud-runner pair <pairing-token>" or mount ${config.sessionTokenPath}.`,
    );
  }
  return config.sessionToken;
}

export function writeSessionToken(config: CloudRunnerConfig, sessionToken: string): void {
  ensureCloudRunnerHome(config);
  writeFileSync(config.sessionTokenPath, `${sessionToken.trim()}\n`, { mode: 0o600 });
  chmodSync(config.sessionTokenPath, 0o600);
}

export function toMacRunnerConfig(
  config: CloudRunnerConfig,
  projects: readonly CloudProject[],
): MacRunnerConfig {
  const projectConfig: Record<string, ProjectConfig> = {};
  for (const project of projects) {
    projectConfig[project.projectId] = {
      name: project.projectId,
      path: project.path,
      addedAt: project.addedAt,
    };
  }
  return {
    version: 1,
    serverUrl: config.serverUrl,
    sessionToken: requireSessionToken(config),
    deviceName: config.runnerName,
    runnerId: config.runnerId,
    runnerName: config.runnerName,
    webSocketOrigin: config.webSocketOrigin,
    projects: projectConfig,
  };
}

function readSessionToken(env: NodeJS.ProcessEnv, tokenPath: string): string | undefined {
  const envToken = env.CLOUD_CODEX_SESSION_TOKEN?.trim();
  if (envToken) return envToken;
  if (!existsSync(tokenPath)) return undefined;
  const fileToken = readFileSync(tokenPath, "utf8").trim();
  return fileToken || undefined;
}

function isLocalhost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
