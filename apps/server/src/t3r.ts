import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@t3tools/shared/Net";
import { Effect, Layer, Option } from "effect";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveServerConfig, type CliServerFlags } from "./cli.ts";
import { ServerConfig } from "./config.ts";
import { runServer } from "./server.ts";

const DEFAULT_REMOTE_URL = "https://codex.anishalle.com";
const INTERNAL_DAEMON_COMMAND = "__daemon";

type T3rPaths = {
  readonly configDir: string;
  readonly tokenPath: string;
  readonly pidPath: string;
  readonly logPath: string;
};

type TokenValidationResult = "valid" | "invalid" | "unknown";

function resolveConfigDir(): string {
  const configured = process.env.T3R_CONFIG_DIR?.trim();
  if (configured) {
    return path.resolve(configured.replace(/^~(?=$|\/)/, os.homedir()));
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  const root = xdgConfigHome ? path.resolve(xdgConfigHome) : path.join(os.homedir(), ".config");
  return path.join(root, "t3r");
}

function resolveRemoteUrl(): string {
  const configured = process.env.T3R_REMOTE_URL?.trim();
  return new URL(configured || DEFAULT_REMOTE_URL).toString();
}

function resolvePaths(): T3rPaths {
  const configDir = resolveConfigDir();
  return {
    configDir,
    tokenPath: process.env.T3R_TOKEN_FILE?.trim() || path.join(configDir, "token"),
    pidPath: process.env.T3R_PID_FILE?.trim() || path.join(configDir, "t3r.pid"),
    logPath: process.env.T3R_LOG_FILE?.trim() || path.join(configDir, "t3r.log"),
  };
}

function endpointUrl(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readResponseError(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(text) as { readonly error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error;
    }
  } catch {
    // Fall through to the raw body.
  }

  return text;
}

async function readSavedToken(tokenPath: string): Promise<string | null> {
  try {
    const token = (await fs.readFile(tokenPath, "utf8")).trim();
    return token.length > 0 ? token : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeSavedToken(tokenPath: string, token: string): Promise<void> {
  await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(tokenPath, `${token.trim()}\n`, { mode: 0o600 });
  await fs.chmod(tokenPath, 0o600).catch(() => undefined);
}

async function validateSavedToken(remoteUrl: string, token: string): Promise<TokenValidationResult> {
  try {
    const response = await fetch(endpointUrl(remoteUrl, "/api/auth/session"), {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      return response.status === 401 || response.status === 403 ? "invalid" : "unknown";
    }
    const session = (await response.json()) as { readonly authenticated?: unknown };
    return session.authenticated === true ? "valid" : "invalid";
  } catch {
    return "unknown";
  }
}

function extractPairingCredential(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    const hashToken = hashParams.get("token")?.trim();
    if (hashToken) {
      return hashToken;
    }
    const searchToken = url.searchParams.get("token")?.trim();
    if (searchToken) {
      return searchToken;
    }
  } catch {
    // The input may already be a raw token or token=... fragment.
  }

  const fragment = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  const params = new URLSearchParams(fragment);
  const paramToken = params.get("token")?.trim();
  return paramToken || trimmed;
}

async function promptForPairingCredential(remoteUrl: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "t3r needs a pairing link or token the first time. Run it in an interactive terminal.",
    );
  }

  console.log(`t3r needs auth for ${remoteUrl}`);
  console.log("Create a pairing link in T3, then paste the full link or token here.");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return extractPairingCredential(await rl.question("Pairing link or token: "));
  } finally {
    rl.close();
  }
}

async function bootstrapBearerToken(remoteUrl: string, credential: string): Promise<string> {
  const response = await fetch(endpointUrl(remoteUrl, "/api/auth/bootstrap/bearer"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ credential }),
  });

  if (!response.ok) {
    throw new Error(
      await readResponseError(response, `Remote auth failed with status ${response.status}.`),
    );
  }

  const result = (await response.json()) as { readonly sessionToken?: unknown };
  if (typeof result.sessionToken !== "string" || result.sessionToken.trim().length === 0) {
    throw new Error("Remote auth did not return a bearer token.");
  }
  return result.sessionToken.trim();
}

async function ensureBridgeToken(remoteUrl: string, paths: T3rPaths): Promise<void> {
  await fs.mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.configDir, 0o700).catch(() => undefined);

  const savedToken = await readSavedToken(paths.tokenPath);
  if (savedToken) {
    const validation = await validateSavedToken(remoteUrl, savedToken);
    if (validation === "valid") {
      return;
    }
    if (validation === "unknown") {
      console.warn("Could not validate saved t3r auth. Starting with the saved token.");
      return;
    }
    console.log("Saved t3r auth is expired or revoked.");
  }

  for (;;) {
    const credential = await promptForPairingCredential(remoteUrl);
    if (!credential) {
      console.log("No token entered.");
      continue;
    }

    try {
      const token = await bootstrapBearerToken(remoteUrl, credential);
      await writeSavedToken(paths.tokenPath, token);
      console.log(`Saved t3r auth to ${paths.tokenPath}`);
      return;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

async function readPid(pidPath: string): Promise<number | null> {
  try {
    const raw = (await fs.readFile(pidPath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function removePidFile(pidPath: string): Promise<void> {
  await fs.unlink(pidPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function startDaemon(paths: T3rPaths, remoteUrl: string): Promise<void> {
  const existingPid = await readPid(paths.pidPath);
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`t3r is already running (pid ${existingPid}).`);
    return;
  }
  if (existingPid) {
    await removePidFile(paths.pidPath);
  }

  await fs.mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  const logHandle = await fs.open(paths.logPath, "a");
  let childPid: number | undefined;
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), INTERNAL_DAEMON_COMMAND], {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        T3R_REMOTE_URL: remoteUrl,
        T3R_TOKEN_FILE: paths.tokenPath,
        T3R_PID_FILE: paths.pidPath,
        T3R_LOG_FILE: paths.logPath,
        T3R_STARTED_CWD: process.cwd(),
      },
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    });
    childPid = child.pid;
    child.unref();
  } finally {
    await logHandle.close();
  }

  if (!childPid) {
    throw new Error("Failed to spawn t3r.");
  }

  await fs.writeFile(paths.pidPath, `${childPid}\n`, { mode: 0o600 });
  await delay(750);
  if (!isProcessAlive(childPid)) {
    await removePidFile(paths.pidPath);
    throw new Error(`t3r exited during startup. See ${paths.logPath}`);
  }

  console.log(`t3r started (pid ${childPid}).`);
  console.log(`Remote: ${remoteUrl}`);
  console.log(`Log: ${paths.logPath}`);
}

async function stopDaemon(paths: T3rPaths): Promise<void> {
  const pid = await readPid(paths.pidPath);
  if (!pid) {
    console.log("t3r is not running.");
    return;
  }
  if (!isProcessAlive(pid)) {
    await removePidFile(paths.pidPath);
    console.log("t3r was not running. Removed stale pid file.");
    return;
  }

  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(100);
    if (!isProcessAlive(pid)) {
      await removePidFile(paths.pidPath);
      console.log("t3r stopped.");
      return;
    }
  }

  await removePidFile(paths.pidPath);
  console.log("t3r stop requested. Process is still shutting down.");
}

function cleanupPidOnExit(paths: T3rPaths): void {
  const cleanup = () => {
    try {
      const raw = fsSync.readFileSync(paths.pidPath, "utf8").trim();
      if (Number.parseInt(raw, 10) === process.pid) {
        fsSync.unlinkSync(paths.pidPath);
      }
    } catch {
      // Best-effort cleanup only.
    }
  };

  process.once("exit", cleanup);
}

function runDaemon(): void {
  const paths = resolvePaths();
  const remoteUrl = resolveRemoteUrl();
  const cwd = process.env.T3R_STARTED_CWD?.trim() || process.cwd();
  cleanupPidOnExit(paths);
  process.title = "t3r";

  const flags: CliServerFlags = {
    mode: Option.some("web"),
    port: Option.none(),
    host: Option.some("127.0.0.1"),
    baseDir: Option.none(),
    cwd: Option.some(cwd),
    devUrl: Option.none(),
    noBrowser: Option.some(true),
    bootstrapFd: Option.none(),
    autoBootstrapProjectFromCwd: Option.some(true),
    logWebSocketEvents: Option.none(),
    bridgeUrl: Option.some(remoteUrl),
    bridgeTokenFile: Option.some(paths.tokenPath),
    bridgeBearerToken: Option.none(),
    bridgePairingToken: Option.none(),
  };

  const RuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
  const program = Effect.gen(function* () {
    const config = yield* resolveServerConfig(flags, Option.none(), {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: true,
    });
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
  }).pipe(Effect.scoped, Effect.provide(RuntimeLayer));

  NodeRuntime.runMain(program);
}

async function main(): Promise<void> {
  const command = process.argv[2]?.trim();
  const paths = resolvePaths();

  if (command === INTERNAL_DAEMON_COMMAND) {
    runDaemon();
    return;
  }

  if (command === "stop") {
    await stopDaemon(paths);
    return;
  }

  if (command && command !== "start") {
    console.error("Usage: t3r");
    console.error("       t3r stop");
    process.exitCode = 1;
    return;
  }

  const remoteUrl = resolveRemoteUrl();
  await ensureBridgeToken(remoteUrl, paths);
  await startDaemon(paths, remoteUrl);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
