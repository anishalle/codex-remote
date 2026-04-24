import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { ApprovalDecision } from "../../../packages/protocol/src/index.ts";
import type { ProjectConfig } from "./config.ts";
import type { RunnerLogger } from "./runner.ts";

export type RuntimeThreadStatus = "starting" | "running" | "ready" | "error" | "closed";

export interface RuntimeStatusUpdate {
  readonly status: RuntimeThreadStatus;
  readonly providerThreadId?: string;
  readonly activeTurnId?: string | null;
  readonly message?: string;
}

export interface RuntimeEvent {
  readonly type: string;
  readonly payload: unknown;
}

export interface RuntimeStartTurnInput {
  readonly cloudThreadId: string;
  readonly project: ProjectConfig;
  readonly prompt: string;
  readonly onStatus: (status: RuntimeStatusUpdate) => void;
  readonly onEvent: (event: RuntimeEvent) => void;
}

export interface RuntimeStartTurnResult {
  readonly providerThreadId: string;
  readonly activeTurnId?: string;
}

export interface LocalRuntimeBridge {
  readonly startTurn: (input: RuntimeStartTurnInput) => Promise<RuntimeStartTurnResult>;
  readonly interruptTurn: (cloudThreadId: string) => Promise<void>;
  readonly resolveApproval: (
    cloudThreadId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ) => Promise<void>;
  readonly listThreads: () => readonly {
    readonly cloudThreadId: string;
    readonly providerThreadId?: string;
    readonly status: RuntimeThreadStatus;
  }[];
  readonly close: () => Promise<void>;
}

export interface CodexRuntimeBridgeOptions {
  readonly binaryPath?: string;
  readonly codexHome?: string;
  readonly sandboxMode?: CodexSandboxMode;
  readonly networkAccess?: boolean;
  readonly logger?: RunnerLogger;
}

type JsonRpcId = string | number;
export type CodexSandboxMode = "read-only" | "workspace-write";

type CodexSandboxPolicy =
  | {
      readonly type: "readOnly";
      readonly access: {
        readonly type: "restricted";
        readonly includePlatformDefaults: boolean;
        readonly readableRoots: readonly string[];
      };
      readonly networkAccess: boolean;
    }
  | {
      readonly type: "workspaceWrite";
      readonly writableRoots: readonly string[];
      readonly readOnlyAccess: {
        readonly type: "restricted";
        readonly includePlatformDefaults: boolean;
        readonly readableRoots: readonly string[];
      };
      readonly networkAccess: boolean;
      readonly excludeTmpdirEnvVar: boolean;
      readonly excludeSlashTmp: boolean;
    };

interface JsonRpcRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcResponse {
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: { readonly message?: string; readonly code?: number | string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponse(value: unknown): value is JsonRpcResponse {
  return isObject(value) && "id" in value && ("result" in value || "error" in value);
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return isObject(value) && "id" in value && typeof value.method === "string";
}

function isNotification(value: unknown): value is JsonRpcNotification {
  return isObject(value) && !("id" in value) && typeof value.method === "string";
}

function readThreadIdFromNotification(method: string, params: unknown): string | undefined {
  if (!isObject(params)) return undefined;
  if (
    method === "thread/started" &&
    isObject(params.thread) &&
    typeof params.thread.id === "string"
  ) {
    return params.thread.id;
  }
  return typeof params.threadId === "string" ? params.threadId : undefined;
}

function redactRuntimeLine(line: string): string {
  return line
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((api[_-]?key|token|secret|password)=)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(OPENAI_API_KEY=)[^\s]+/g, "$1[REDACTED]");
}

export function createCodexSandboxPolicy(input: {
  readonly projectPath: string;
  readonly mode?: CodexSandboxMode;
  readonly networkAccess?: boolean;
}): CodexSandboxPolicy {
  const mode = input.mode ?? "workspace-write";
  const networkAccess = input.networkAccess ?? false;
  const readOnlyAccess = {
    type: "restricted" as const,
    includePlatformDefaults: true,
    readableRoots: [input.projectPath],
  };

  if (mode === "read-only") {
    return {
      type: "readOnly",
      access: readOnlyAccess,
      networkAccess,
    };
  }

  return {
    type: "workspaceWrite",
    writableRoots: [input.projectPath],
    readOnlyAccess,
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function readCodexSandboxMode(env: NodeJS.ProcessEnv): CodexSandboxMode {
  const value = env.CLOUD_CODEX_CODEX_SANDBOX?.trim();
  if (!value) return "workspace-write";
  if (value === "read-only" || value === "workspace-write") return value;
  throw new Error("CLOUD_CODEX_CODEX_SANDBOX must be read-only or workspace-write.");
}

function readTurnIdFromNotification(params: unknown): string | undefined {
  if (!isObject(params)) return undefined;
  if (isObject(params.turn) && typeof params.turn.id === "string") {
    return params.turn.id;
  }
  return typeof params.turnId === "string" ? params.turnId : undefined;
}

function statusFromNotification(method: string, params: unknown): RuntimeStatusUpdate | null {
  if (method === "turn/started") {
    return {
      status: "running",
      activeTurnId: readTurnIdFromNotification(params),
    };
  }
  if (method === "turn/completed") {
    const failed =
      isObject(params) &&
      isObject(params.turn) &&
      typeof params.turn.status === "string" &&
      params.turn.status === "failed";
    return {
      status: failed ? "error" : "ready",
      activeTurnId: null,
      ...(failed ? { message: "Codex turn failed." } : {}),
    };
  }
  if (method === "thread/status/changed" && isObject(params)) {
    return {
      status: "running",
      ...(typeof params.status === "string" ? { message: params.status } : {}),
    };
  }
  if (method === "thread/closed") {
    return {
      status: "closed",
      activeTurnId: null,
    };
  }
  if (method === "error") {
    const message =
      isObject(params) && isObject(params.error) && typeof params.error.message === "string"
        ? params.error.message
        : "Codex runtime error.";
    return {
      status: "error",
      activeTurnId: null,
      message,
    };
  }
  return null;
}

class JsonRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  private nextId = 1;
  private stdoutBuffer = "";
  onNotification?: (notification: JsonRpcNotification) => void;
  onRequest?: (request: JsonRpcRequest) => Promise<unknown>;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null) => void;

  constructor(input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly codexHome?: string;
  }) {
    this.child = spawn(input.binaryPath, ["app-server"], {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...(input.codexHome ? { CODEX_HOME: input.codexHome } : {}),
      },
      stdio: "pipe",
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed) this.onStderr?.(trimmed);
      }
    });
    this.child.on("exit", (code) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`codex app-server exited with code ${code ?? "unknown"}.`));
      }
      this.pending.clear();
      this.onExit?.(code);
    });
    this.child.on("error", (error) => {
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.onExit?.(null);
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.write({
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: JsonRpcId, message: string): void {
    this.write({
      id,
      error: {
        code: -32603,
        message,
      },
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) {
        resolve();
        return;
      }
      this.child.once("exit", () => resolve());
      this.child.kill("SIGTERM");
      setTimeout(() => {
        if (this.child.exitCode === null) {
          this.child.kill("SIGKILL");
        }
      }, 1000).unref();
    });
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      this.handleLine(line.replace(/\r$/, ""));
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      return;
    }
    if (isResponse(decoded)) {
      const pending = this.pending.get(String(decoded.id));
      if (!pending) return;
      this.pending.delete(String(decoded.id));
      if (decoded.error) {
        pending.reject(new Error(decoded.error.message ?? "Codex app-server request failed."));
        return;
      }
      pending.resolve(decoded.result);
      return;
    }
    if (isRequest(decoded)) {
      void (async () => {
        try {
          const result = this.onRequest ? await this.onRequest(decoded) : {};
          this.respond(decoded.id, result);
        } catch (error) {
          this.respondError(
            decoded.id,
            error instanceof Error ? error.message : "Codex app-server request failed.",
          );
        }
      })();
      return;
    }
    if (isNotification(decoded)) {
      this.onNotification?.(decoded);
    }
  }
}

interface RuntimeSession {
  readonly cloudThreadId: string;
  readonly project: ProjectConfig;
  readonly process: JsonRpcProcess;
  providerThreadId?: string;
  activeTurnId?: string;
  status: RuntimeThreadStatus;
  pendingApprovals: Map<string, (decision: ApprovalDecision) => void>;
}

export class CodexRuntimeBridge implements LocalRuntimeBridge {
  private readonly binaryPath: string;
  private readonly codexHome?: string;
  private readonly sandboxMode: CodexSandboxMode;
  private readonly networkAccess: boolean;
  private readonly logger?: RunnerLogger;
  private readonly sessions = new Map<string, RuntimeSession>();

  constructor(options: CodexRuntimeBridgeOptions = {}) {
    this.binaryPath = options.binaryPath ?? process.env.CLOUD_CODEX_CODEX_BINARY ?? "codex";
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME;
    this.sandboxMode = options.sandboxMode ?? readCodexSandboxMode(process.env);
    this.networkAccess = options.networkAccess ?? process.env.CLOUD_CODEX_NETWORK_ACCESS === "1";
    this.logger = options.logger;
  }

  async startTurn(input: RuntimeStartTurnInput): Promise<RuntimeStartTurnResult> {
    let session = this.sessions.get(input.cloudThreadId);
    if (!session) {
      session = this.createSession(input);
      this.sessions.set(input.cloudThreadId, session);
      await this.initializeSession(session, input);
    }

    input.onStatus({
      status: "running",
      providerThreadId: session.providerThreadId,
    });
    input.onEvent({
      type: "codex.turn.requested",
      payload: {
        cloudThreadId: input.cloudThreadId,
        providerThreadId: session.providerThreadId,
        promptLength: input.prompt.length,
      },
    });

    const response = await session.process.request("turn/start", {
      threadId: session.providerThreadId,
      input: [{ type: "text", text: input.prompt }],
      approvalPolicy: "untrusted",
      sandboxPolicy: createCodexSandboxPolicy({
        projectPath: input.project.path,
        mode: this.sandboxMode,
        networkAccess: this.networkAccess,
      }),
    });
    const activeTurnId = readTurnIdFromResponse(response);
    session.status = "running";
    session.activeTurnId = activeTurnId;
    input.onStatus({
      status: "running",
      providerThreadId: session.providerThreadId,
      activeTurnId,
    });
    return {
      providerThreadId: session.providerThreadId ?? "",
      ...(activeTurnId ? { activeTurnId } : {}),
    };
  }

  listThreads(): readonly {
    readonly cloudThreadId: string;
    readonly providerThreadId?: string;
    readonly status: RuntimeThreadStatus;
  }[] {
    return Array.from(this.sessions.values()).map((session) => ({
      cloudThreadId: session.cloudThreadId,
      ...(session.providerThreadId ? { providerThreadId: session.providerThreadId } : {}),
      status: session.status,
    }));
  }

  async interruptTurn(cloudThreadId: string): Promise<void> {
    const session = this.sessions.get(cloudThreadId);
    if (!session?.providerThreadId || !session.activeTurnId) {
      return;
    }
    await session.process.request("turn/interrupt", {
      threadId: session.providerThreadId,
      turnId: session.activeTurnId,
    });
  }

  async resolveApproval(
    cloudThreadId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const session = this.sessions.get(cloudThreadId);
    const resolve = session?.pendingApprovals.get(approvalId);
    if (!session || !resolve) {
      throw new Error(`Unknown pending approval ${approvalId}.`);
    }
    session.pendingApprovals.delete(approvalId);
    resolve(decision);
  }

  async close(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.process.close()));
  }

  private createSession(input: RuntimeStartTurnInput): RuntimeSession {
    const process = new JsonRpcProcess({
      binaryPath: this.binaryPath,
      cwd: input.project.path,
      ...(this.codexHome ? { codexHome: this.codexHome } : {}),
    });
    const session: RuntimeSession = {
      cloudThreadId: input.cloudThreadId,
      project: input.project,
      process,
      status: "starting",
      pendingApprovals: new Map(),
    };
    process.onNotification = (notification) => {
      const providerThreadId = readThreadIdFromNotification(notification.method, notification.params);
      if (providerThreadId) {
        session.providerThreadId = providerThreadId;
      }
      const status = statusFromNotification(notification.method, notification.params);
      if (status) {
        session.status = status.status;
        if (status.activeTurnId !== undefined) {
          session.activeTurnId = status.activeTurnId ?? undefined;
        }
        input.onStatus({
          ...status,
          providerThreadId: status.providerThreadId ?? session.providerThreadId,
        });
      }
      input.onEvent({
        type: "codex.notification",
        payload: {
          method: notification.method,
          params: notification.params ?? null,
          providerThreadId: session.providerThreadId,
        },
      });
    };
    process.onRequest = async (request) => {
      if (
        request.method === "item/commandExecution/requestApproval" ||
        request.method === "item/fileChange/requestApproval"
      ) {
        const approvalId = `approval_${randomUUID()}`;
        input.onEvent({
          type: "codex.approval.requested",
          payload: {
            approvalId,
            approvalType:
              request.method === "item/commandExecution/requestApproval" ? "command" : "file-change",
            method: request.method,
            params: request.params ?? null,
            providerThreadId: session.providerThreadId,
          },
        });
        const decision = await new Promise<ApprovalDecision>((resolve) => {
          session.pendingApprovals.set(approvalId, resolve);
        });
        input.onEvent({
          type: "codex.approval.resolved",
          payload: {
            approvalId,
            decision,
            providerThreadId: session.providerThreadId,
          },
        });
        return { decision };
      }
      input.onEvent({
        type: "codex.request",
        payload: {
          method: request.method,
          params: request.params ?? null,
          providerThreadId: session.providerThreadId,
        },
      });
      return {};
    };
    process.onStderr = (line) => {
      const redacted = redactRuntimeLine(line);
      this.logger?.warn(`codex stderr: ${redacted}`);
      input.onEvent({
        type: "codex.stderr",
        payload: {
          message: redacted,
          providerThreadId: session.providerThreadId,
        },
      });
    };
    process.onExit = (code) => {
      session.status = code === 0 ? "closed" : "error";
      input.onStatus({
        status: session.status,
        providerThreadId: session.providerThreadId,
        message: code === 0 ? "Codex app-server exited." : `Codex app-server exited with ${code}.`,
      });
    };
    return session;
  }

  private async initializeSession(
    session: RuntimeSession,
    input: RuntimeStartTurnInput,
  ): Promise<void> {
    input.onStatus({ status: "starting" });
    await session.process.request("initialize", {
      clientInfo: {
        name: "cloudcodex_mac_runner",
        title: "CloudCodex Mac Runner",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    session.process.notify("initialized");
    const response = await session.process.request("thread/start", {
      cwd: input.project.path,
      approvalPolicy: "untrusted",
      sandbox: this.sandboxMode,
    });
    const providerThreadId =
      readProviderThreadIdFromThreadResponse(response) ?? `unknown_${randomUUID()}`;
    session.providerThreadId = providerThreadId;
    session.status = "ready";
    input.onStatus({
      status: "ready",
      providerThreadId,
    });
    input.onEvent({
      type: "codex.thread.started",
      payload: {
        cloudThreadId: input.cloudThreadId,
        providerThreadId,
        projectName: input.project.name,
        workspaceRoot: input.project.path,
      },
    });
  }
}

function readProviderThreadIdFromThreadResponse(response: unknown): string | undefined {
  if (!isObject(response)) return undefined;
  if (isObject(response.thread) && typeof response.thread.id === "string") {
    return response.thread.id;
  }
  return undefined;
}

function readTurnIdFromResponse(response: unknown): string | undefined {
  if (!isObject(response)) return undefined;
  if (isObject(response.turn) && typeof response.turn.id === "string") {
    return response.turn.id;
  }
  return undefined;
}
