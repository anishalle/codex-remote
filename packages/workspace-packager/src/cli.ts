import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { CloudEvent } from "../../protocol/src/index.ts";
import {
  createHandoffPackage,
  inspectHandoffPackage,
  redactedManifest,
} from "./package.ts";
import { summarizeEvents } from "./prompt.ts";

const DEFAULT_CHUNK_SIZE = 512 * 1024;

interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const defaultIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

export async function runCli(
  argv: readonly string[],
  input: { readonly env?: NodeJS.ProcessEnv; readonly io?: CliIo } = {},
): Promise<number> {
  const env = input.env ?? process.env;
  const io = input.io ?? defaultIo;
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "detect-env":
        io.stdout(JSON.stringify(detectEnv(args, env), null, 2));
        return 0;
      case "make-bundle":
        io.stdout(JSON.stringify(makeBundle(args), null, 2));
        return 0;
      case "redact-manifest":
        io.stdout(JSON.stringify(redactManifestCommand(args), null, 2));
        return 0;
      case "send-to-cloud":
        io.stdout(JSON.stringify(await sendToCloud(args, env), null, 2));
        return 0;
      case "-h":
      case "--help":
      case "help":
      case undefined:
        io.stdout(usage());
        return 0;
      default:
        throw new Error(`Unknown workspace-packager command "${command}".`);
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function detectEnv(args: readonly string[], env: NodeJS.ProcessEnv) {
  const workspace = resolve(readOption(args, "--workspace") ?? process.cwd());
  const root = git(workspace, ["rev-parse", "--show-toplevel"]).trim();
  return {
    workspaceRoot: root,
    gitHead: git(root, ["rev-parse", "HEAD"]).trim(),
    gitBranch: git(root, ["branch", "--show-current"]).trim() || null,
    cloudServerUrl: readOption(args, "--server-url") ?? env.CLOUD_CODEX_SERVER_URL ?? null,
    hasSessionToken: Boolean(readToken(args, env, false)),
    cloudThreadId: readOption(args, "--thread-id") ?? env.CLOUD_CODEX_THREAD_ID ?? null,
  };
}

function makeBundle(args: readonly string[]) {
  const workspaceRoot = readOption(args, "--workspace") ?? process.cwd();
  const outputPath = resolve(readOption(args, "--output") ?? ".cloudcodex-handoff.json");
  const summary = readTextOption(args, "--summary", "--summary-file") ?? "No handoff summary was provided.";
  const instruction = readTextOption(args, "--instruction", "--instruction-file");
  return createHandoffPackage({
    workspaceRoot,
    outputPath,
    includeUntracked: readMulti(args, "--include-untracked"),
    localThreadId: readOption(args, "--thread-id"),
    exportedEventCount: readIntegerOption(args, "--event-count") ?? 0,
    summary,
    userInstruction: instruction,
  });
}

function redactManifestCommand(args: readonly string[]) {
  const inputPath = readOption(args, "--input") ?? args[0];
  if (!inputPath) throw new Error("Usage: redact-manifest --input <handoff-package.json>");
  const inspected = inspectHandoffPackage(readFileSync(inputPath, "utf8"));
  return redactedManifest(inspected.handoffPackage.manifest);
}

async function sendToCloud(args: readonly string[], env: NodeJS.ProcessEnv) {
  const serverUrl = normalizeServerUrl(requiredOption(args, env, "--server-url", "CLOUD_CODEX_SERVER_URL"));
  const token = readToken(args, env, true);
  const runnerId = requiredOption(args, env, "--runner-id", "CLOUD_CODEX_RUNNER_ID");
  const projectId = requiredOption(args, env, "--project-id", "CLOUD_CODEX_PROJECT_ID");
  const workspaceRoot = readOption(args, "--workspace") ?? process.cwd();
  const threadId = readOption(args, "--thread-id") ?? env.CLOUD_CODEX_THREAD_ID;
  const instruction = readTextOption(args, "--instruction", "--instruction-file");
  const tmp = mkdtempSync(join(tmpdir(), "cloudcodex-send-"));
  try {
    const events = threadId ? await fetchAllEvents({ serverUrl, token, threadId }) : [];
    const summary =
      readTextOption(args, "--summary", "--summary-file") ||
      (events.length > 0 ? summarizeEvents(events) : "No prior CloudCodex events were exported.");
    const outputPath = resolve(readOption(args, "--output") ?? join(tmp, "handoff.json"));
    const created = createHandoffPackage({
      workspaceRoot,
      outputPath,
      includeUntracked: readMulti(args, "--include-untracked"),
      localThreadId: threadId,
      exportedEventCount: events.length,
      summary,
      userInstruction: instruction,
    });
    const init = await postJson({
      serverUrl,
      token,
      path: "/api/uploads/init",
      body: {
        runnerId,
        projectId,
        totalBytes: created.bytes,
        sha256: created.sha256,
        manifest: created.manifest,
      },
    });
    await uploadChunks({
      serverUrl,
      token,
      uploadId: init.uploadId,
      packagePath: outputPath,
      chunkSize: init.chunkSize || DEFAULT_CHUNK_SIZE,
    });
    const complete = await postJson({
      serverUrl,
      token,
      path: `/api/uploads/${encodeURIComponent(init.uploadId)}/complete`,
      body: { sha256: created.sha256 },
    });
    return {
      uploadId: init.uploadId,
      runnerId,
      projectId,
      packageSha256: created.sha256,
      exportedEventCount: events.length,
      status: complete.status,
      commandId: complete.commandId,
      note: "cloud-server will start the cloud Codex thread after the runner unpacks the workspace",
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function uploadChunks(input: {
  readonly serverUrl: string;
  readonly token: string;
  readonly uploadId: string;
  readonly packagePath: string;
  readonly chunkSize: number;
}): Promise<void> {
  const raw = readFileSync(input.packagePath);
  let index = 0;
  for (let offset = 0; offset < raw.byteLength; offset += input.chunkSize) {
    const chunk = raw.subarray(offset, Math.min(offset + input.chunkSize, raw.byteLength));
    await postJson({
      serverUrl: input.serverUrl,
      token: input.token,
      path: `/api/uploads/${encodeURIComponent(input.uploadId)}/chunks`,
      body: {
        index,
        dataBase64: chunk.toString("base64"),
        sha256: sha256(chunk),
      },
    });
    index += 1;
  }
}

async function fetchAllEvents(input: {
  readonly serverUrl: string;
  readonly token: string;
  readonly threadId: string;
}): Promise<CloudEvent[]> {
  const events: CloudEvent[] = [];
  let afterSequence = 0;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL("/api/events", input.serverUrl);
    url.searchParams.set("threadId", input.threadId);
    url.searchParams.set("afterSequence", String(afterSequence));
    url.searchParams.set("limit", "500");
    const body = await getJson({ url, token: input.token });
    const pageEvents = Array.isArray(body.events) ? (body.events as CloudEvent[]) : [];
    events.push(...pageEvents);
    if (pageEvents.length === 0 || pageEvents.length < 500) break;
    afterSequence = pageEvents[pageEvents.length - 1]?.sequence ?? afterSequence;
  }
  return events;
}

async function postJson(input: {
  readonly serverUrl: string;
  readonly token: string;
  readonly path: string;
  readonly body: unknown;
}): Promise<any> {
  const url = new URL(input.path, input.serverUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input.body),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `HTTP ${response.status} from ${url.pathname}`);
  }
  return body;
}

async function getJson(input: { readonly url: URL; readonly token: string }): Promise<any> {
  const response = await fetch(input.url, {
    headers: {
      authorization: `Bearer ${input.token}`,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `HTTP ${response.status} from ${input.url.pathname}`);
  }
  return body;
}

function requiredOption(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  option: string,
  envName: string,
): string {
  const value = readOption(args, option) ?? env[envName];
  if (!value?.trim()) throw new Error(`${option} or ${envName} is required.`);
  return value.trim();
}

function readToken(args: readonly string[], env: NodeJS.ProcessEnv, required: true): string;
function readToken(args: readonly string[], env: NodeJS.ProcessEnv, required: false): string | undefined;
function readToken(args: readonly string[], env: NodeJS.ProcessEnv, required: boolean): string | undefined {
  const token =
    readOption(args, "--token") ??
    env.CLOUD_CODEX_SESSION_TOKEN ??
    readFileOption(args, "--token-file") ??
    (env.CLOUD_CODEX_SESSION_TOKEN_FILE ? readOptionalFile(env.CLOUD_CODEX_SESSION_TOKEN_FILE) : undefined);
  if (required && !token?.trim()) {
    throw new Error("--token, --token-file, CLOUD_CODEX_SESSION_TOKEN, or CLOUD_CODEX_SESSION_TOKEN_FILE is required.");
  }
  return token?.trim();
}

function readTextOption(args: readonly string[], inlineName: string, fileName: string): string | undefined {
  return readOption(args, inlineName) ?? readFileOption(args, fileName);
}

function readFileOption(args: readonly string[], name: string): string | undefined {
  const path = readOption(args, name);
  return path ? readFileSync(path, "utf8").trim() : undefined;
}

function readOptionalFile(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function readIntegerOption(args: readonly string[], name: string): number | undefined {
  const raw = readOption(args, name);
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function readMulti(args: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    values.push(...value.split(",").map((entry) => entry.trim()).filter(Boolean));
  }
  return values;
}

function normalizeServerUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("cloud-server URL must use http:// or https://.");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function usage(): string {
  return [
    "Usage:",
    "  workspace-packager detect-env [--workspace <path>]",
    "  workspace-packager make-bundle --output <path> [--include-untracked <path>]",
    "  workspace-packager redact-manifest --input <handoff-package.json>",
    "  workspace-packager send-to-cloud --server-url <url> --token-file <file> --runner-id <id> --project-id <id>",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await runCli(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
