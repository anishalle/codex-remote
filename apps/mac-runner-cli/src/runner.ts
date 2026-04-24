import { randomUUID } from "node:crypto";

import {
  ServerMessageSchema,
  createEnvelope,
  parseJson,
  type ApprovalDecision,
  type RunnerEventAppendPayload,
  type RunnerProjectCreatePayload,
  type RunnerThreadStatusPayload,
  type RunnerWorkspaceUnpackPayload,
  type RunnerTurnInterruptPayload,
  type RunnerTurnSteerPayload,
  type RunnerTurnStartPayload,
} from "../../../packages/protocol/src/index.ts";
import {
  requireServerUrl,
  requireSessionToken,
  toRunnerWebSocketUrl,
  validateRegisteredProject,
  type MacRunnerConfig,
  type ProjectConfig,
} from "./config.ts";
import { CodexRuntimeBridge, type LocalRuntimeBridge, type RuntimeEvent } from "./local-codex.ts";
import { RunnerStateDatabase, type QueuedEvent } from "./state.ts";
import { connectOutboundWebSocket, type OutboundWebSocket } from "./ws-client.ts";

export const MAC_RUNNER_VERSION = "0.3.0";

export interface RunnerLogger {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
}

export interface FlushResult {
  readonly sent: number;
  readonly acked: number;
}

export interface ConnectAndFlushInput {
  readonly config: MacRunnerConfig;
  readonly state: RunnerStateDatabase;
  readonly timeoutMs?: number;
  readonly logger?: RunnerLogger;
}

export interface DaemonOptions {
  readonly heartbeatIntervalMs?: number;
  readonly flushIntervalMs?: number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly signal?: AbortSignal;
  readonly logger?: RunnerLogger;
  readonly runtimeBridge?: LocalRuntimeBridge;
  readonly projectManager?: RunnerProjectManager;
}

export interface RunnerProjectManager {
  readonly createProject: (input: {
    readonly projectId: string;
    readonly name?: string;
  }) => Promise<ProjectConfig>;
  readonly unpackWorkspace?: (input: {
    readonly uploadId: string;
    readonly projectId: string;
  }) => Promise<ProjectConfig>;
}

const defaultLogger: RunnerLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export function enqueueMockRun(input: {
  readonly state: RunnerStateDatabase;
  readonly runnerId: string;
  readonly project: ProjectConfig;
  readonly prompt: string;
}): { readonly threadId: string; readonly eventIds: readonly string[] } {
  const threadId = `thread_${randomUUID()}`;
  const started = input.state.enqueueEvent({
    projectName: input.project.name,
    projectPath: input.project.path,
    threadId,
    type: "mock.codex.turn.started",
    payload: {
      runnerId: input.runnerId,
      projectName: input.project.name,
      workspaceRoot: input.project.path,
      prompt: input.prompt,
      source: "mac-runner-cli",
      mocked: true,
    },
  });
  const message = input.state.enqueueEvent({
    projectName: input.project.name,
    projectPath: input.project.path,
    threadId,
    type: "mock.codex.output.message",
    payload: {
      role: "assistant",
      text: "Mocked local runner event. Real T3/Codex wiring starts in a later phase.",
      mocked: true,
    },
  });
  return {
    threadId,
    eventIds: [started.eventId, message.eventId],
  };
}

export async function connectAndFlushOnce(input: ConnectAndFlushInput): Promise<FlushResult> {
  const serverUrl = requireServerUrl(input.config);
  const sessionToken = requireSessionToken(input.config);
  const logger = input.logger ?? defaultLogger;
  const timeoutMs = input.timeoutMs ?? 10000;
  const socket = await connectOutboundWebSocket({
    url: toRunnerWebSocketUrl(serverUrl),
    authorizationToken: sessionToken,
    origin: input.config.webSocketOrigin,
    handshakeTimeoutMs: timeoutMs,
  });

  let sent = 0;
  let acked = 0;
  const pending = input.state.listPending();
  const pendingAcks = new Set<string>();
  let helloAcked = false;

  const cleanup = () => {
    socket.close();
  };

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => {
          reject(error);
        };
        socket.onClose = () => {
          if (!helloAcked || pendingAcks.size > 0) {
            fail(new Error("WebSocket closed before runner queue was flushed."));
          }
        };
        socket.onText = (raw) => {
          const parsed = parseJson(ServerMessageSchema, raw);
          if (!parsed.ok) {
            fail(new Error(parsed.error));
            return;
          }
          const message = parsed.value;
          if (message.type === "error") {
            logger.warn(`cloud-server error: ${message.payload.code}`);
            return;
          }
          if (message.type === "runner.hello.ack") {
            helloAcked = true;
            for (const event of pending) {
              sendQueuedEvent(socket, input.state, event);
              sent += 1;
              pendingAcks.add(event.eventId);
            }
            if (pending.length === 0) {
              resolve();
            }
            return;
          }
          if (message.type === "runner.event.ack") {
            input.state.markAcked(message.payload.eventId, message.payload.sequence);
            acked += 1;
            pendingAcks.delete(message.payload.eventId);
            if (pendingAcks.size === 0) {
              resolve();
            }
          }
        };

        socket.sendJson(
          createEnvelope("runner.hello", {
            runnerId: input.config.runnerId,
            name: input.config.runnerName,
            version: MAC_RUNNER_VERSION,
            capabilities: ["mock-events", "queue-backfill"],
            projects: projectDescriptors(input.config),
          }),
        );
      }),
      timeoutMs,
    );
    return { sent, acked };
  } finally {
    cleanup();
  }
}

export class MacRunnerDaemon {
  config: MacRunnerConfig;
  readonly state: RunnerStateDatabase;
  readonly options: Required<
    Omit<DaemonOptions, "signal" | "logger" | "runtimeBridge" | "projectManager">
  > & {
    readonly signal?: AbortSignal;
    readonly logger: RunnerLogger;
    readonly runtimeBridge: LocalRuntimeBridge;
    readonly projectManager?: RunnerProjectManager;
  };

  constructor(input: {
    readonly config: MacRunnerConfig;
    readonly state: RunnerStateDatabase;
    readonly options?: DaemonOptions;
  }) {
    this.config = input.config;
    this.state = input.state;
    this.options = {
      heartbeatIntervalMs: input.options?.heartbeatIntervalMs ?? 30000,
      flushIntervalMs: input.options?.flushIntervalMs ?? 5000,
      reconnectBaseMs: input.options?.reconnectBaseMs ?? 1000,
      reconnectMaxMs: input.options?.reconnectMaxMs ?? 30000,
      signal: input.options?.signal,
      logger: input.options?.logger ?? defaultLogger,
      runtimeBridge:
        input.options?.runtimeBridge ?? new CodexRuntimeBridge({ logger: input.options?.logger }),
      projectManager: input.options?.projectManager,
    };
  }

  async run(): Promise<void> {
    let reconnectDelay = this.options.reconnectBaseMs;
    try {
      while (!this.options.signal?.aborted) {
        try {
          await this.runConnection();
          reconnectDelay = this.options.reconnectBaseMs;
        } catch (error) {
          this.options.logger.warn(
            `runner connection failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (this.options.signal?.aborted) break;
        await sleep(reconnectDelay, this.options.signal);
        reconnectDelay = Math.min(reconnectDelay * 2, this.options.reconnectMaxMs);
      }
    } finally {
      await this.options.runtimeBridge.close();
    }
  }

  private async runConnection(): Promise<void> {
    const serverUrl = requireServerUrl(this.config);
    const sessionToken = requireSessionToken(this.config);
    const socket = await connectOutboundWebSocket({
      url: toRunnerWebSocketUrl(serverUrl),
      authorizationToken: sessionToken,
      origin: this.config.webSocketOrigin,
    });
    this.options.logger.info(`connected runner ${this.config.runnerId}`);

    let ready = false;
    const inFlight = new Set<string>();
    const flushPending = () => {
      if (!ready) return;
      for (const event of this.state.listPending()) {
        if (inFlight.has(event.eventId)) continue;
        inFlight.add(event.eventId);
        sendQueuedEvent(socket, this.state, event);
      }
    };
    const heartbeat = setInterval(() => {
      socket.sendJson(createEnvelope("ping", { nonce: randomUUID() }));
    }, this.options.heartbeatIntervalMs);
    const flush = setInterval(flushPending, this.options.flushIntervalMs);

    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          socket.close();
          resolve();
        };
        this.options.signal?.addEventListener("abort", abort, { once: true });
        socket.onClose = () => {
          this.options.signal?.removeEventListener("abort", abort);
          resolve();
        };
        socket.onText = (raw) => {
          const parsed = parseJson(ServerMessageSchema, raw);
          if (!parsed.ok) {
            reject(new Error(parsed.error));
            return;
          }
          const message = parsed.value;
          if (message.type === "runner.hello.ack") {
            ready = true;
            flushPending();
            return;
          }
          if (message.type === "runner.event.ack") {
            inFlight.delete(message.payload.eventId);
            this.state.markAcked(message.payload.eventId, message.payload.sequence);
            return;
          }
          if (message.type === "runner.turn.start") {
            void this.handleTurnStartCommand({
              socket,
              command: message.payload,
              flushPending,
            });
            return;
          }
          if (message.type === "runner.turn.steer") {
            void this.handleTurnSteerCommand({
              socket,
              command: message.payload,
              flushPending,
            });
            return;
          }
          if (message.type === "runner.turn.interrupt") {
            void this.handleTurnInterruptCommand({ socket, command: message.payload });
            return;
          }
          if (message.type === "runner.approval.resolve") {
            void this.handleApprovalResolveCommand({ socket, command: message.payload });
            return;
          }
          if (message.type === "runner.project.create") {
            void this.handleProjectCreateCommand({ socket, command: message.payload });
            return;
          }
          if (message.type === "runner.workspace.unpack") {
            void this.handleWorkspaceUnpackCommand({ socket, command: message.payload });
            return;
          }
          if (message.type === "error") {
            this.options.logger.warn(`cloud-server error: ${message.payload.code}`);
          }
        };
        socket.sendJson(
          createEnvelope("runner.hello", {
            runnerId: this.config.runnerId,
            name: this.config.runnerName,
            version: MAC_RUNNER_VERSION,
            capabilities: [
              "codex-app-server-stdio",
              "queue-backfill",
              "thread-status",
              ...(this.options.projectManager ? ["cloud-project-create"] : []),
              ...(this.options.projectManager?.unpackWorkspace ? ["cloud-workspace-unpack"] : []),
            ],
            projects: projectDescriptors(this.config),
          }),
        );
      });
    } finally {
      clearInterval(heartbeat);
      clearInterval(flush);
      socket.close();
    }
  }

  private async handleProjectCreateCommand(input: {
    readonly socket: OutboundWebSocket;
    readonly command: RunnerProjectCreatePayload;
  }): Promise<void> {
    if (!this.options.projectManager) {
      sendCommandAck(
        input.socket,
        input.command.commandId,
        false,
        undefined,
        "Runner cannot create cloud projects.",
      );
      return;
    }
    try {
      const project = await this.options.projectManager.createProject({
        projectId: input.command.projectId,
        name: input.command.name,
      });
      this.config = {
        ...this.config,
        projects: {
          ...this.config.projects,
          [project.name]: project,
        },
      };
      sendCommandAck(input.socket, input.command.commandId, true);
      input.socket.sendJson(
        createEnvelope("runner.project.created", {
          commandId: input.command.commandId,
          projectId: project.name,
          name: project.name,
          createdAt: project.addedAt,
        }),
      );
    } catch (error) {
      sendCommandAck(
        input.socket,
        input.command.commandId,
        false,
        undefined,
        error instanceof Error ? error.message : "Failed to create cloud project.",
      );
    }
  }

  private async handleWorkspaceUnpackCommand(input: {
    readonly socket: OutboundWebSocket;
    readonly command: RunnerWorkspaceUnpackPayload;
  }): Promise<void> {
    const unpackWorkspace = this.options.projectManager?.unpackWorkspace;
    if (!unpackWorkspace) {
      sendCommandAck(
        input.socket,
        input.command.commandId,
        false,
        undefined,
        "Runner cannot unpack cloud workspaces.",
      );
      return;
    }
    try {
      const project = await unpackWorkspace({
        uploadId: input.command.uploadId,
        projectId: input.command.projectId,
      });
      this.config = {
        ...this.config,
        projects: {
          ...this.config.projects,
          [project.name]: project,
        },
      };
      sendCommandAck(input.socket, input.command.commandId, true);
      input.socket.sendJson(
        createEnvelope("runner.workspace.unpacked", {
          commandId: input.command.commandId,
          uploadId: input.command.uploadId,
          projectId: project.name,
          name: project.name,
          createdAt: project.addedAt,
        }),
      );
    } catch (error) {
      sendCommandAck(
        input.socket,
        input.command.commandId,
        false,
        undefined,
        error instanceof Error ? error.message : "Failed to unpack cloud workspace.",
      );
    }
  }

  private async handleTurnStartCommand(input: {
    readonly socket: OutboundWebSocket;
    readonly command: RunnerTurnStartPayload;
    readonly flushPending: () => void;
  }): Promise<void> {
    const { socket, command, flushPending } = input;
    try {
      const project = validateRegisteredProject(this.config, command.projectId);
      this.state.upsertThreadMapping({
        cloudThreadId: command.cloudThreadId,
        projectName: project.name,
        projectPath: project.path,
        status: "starting",
      });
      socket.sendJson(
        createEnvelope("runner.command.ack", {
          commandId: command.commandId,
          accepted: true,
          cloudThreadId: command.cloudThreadId,
        }),
      );
      sendThreadStatus(socket, {
        cloudThreadId: command.cloudThreadId,
        projectId: command.projectId,
        status: "starting",
      });
      await this.options.runtimeBridge.startTurn({
        cloudThreadId: command.cloudThreadId,
        project,
        prompt: command.prompt,
        onStatus: (status) => {
          const mapping = this.state.upsertThreadMapping({
            cloudThreadId: command.cloudThreadId,
            projectName: project.name,
            projectPath: project.path,
            providerThreadId: status.providerThreadId,
            status: status.status,
            activeTurnId: status.activeTurnId,
          });
          sendThreadStatus(socket, {
            cloudThreadId: command.cloudThreadId,
            projectId: command.projectId,
            status: status.status,
            ...(mapping.providerThreadId ? { providerThreadId: mapping.providerThreadId } : {}),
            ...(mapping.activeTurnId ? { activeTurnId: mapping.activeTurnId } : {}),
            lastEventSequence: mapping.lastLocalSequence,
            ...(status.message ? { message: status.message } : {}),
          });
        },
        onEvent: (event) => {
          this.forwardRuntimeControlEvent({
            socket,
            command,
            project,
            event,
          });
          enqueueRuntimeEvent({
            state: this.state,
            project,
            cloudThreadId: command.cloudThreadId,
            event,
          });
          flushPending();
        },
      });
      flushPending();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start local Codex turn.";
      socket.sendJson(
        createEnvelope("runner.command.ack", {
          commandId: command.commandId,
          accepted: false,
          cloudThreadId: command.cloudThreadId,
          message,
        }),
      );
      this.state.upsertThreadMapping({
        cloudThreadId: command.cloudThreadId,
        projectName: command.projectId,
        projectPath: "",
        status: "error",
      });
      sendThreadStatus(socket, {
        cloudThreadId: command.cloudThreadId,
        projectId: command.projectId,
        status: "error",
        message,
      });
    }
  }

  private async handleTurnSteerCommand(input: {
    readonly socket: OutboundWebSocket;
    readonly command: RunnerTurnSteerPayload;
    readonly flushPending: () => void;
  }): Promise<void> {
    const mapping = this.state.getThreadMapping(input.command.cloudThreadId);
    if (!mapping) {
      sendCommandAck(input.socket, input.command.commandId, false, input.command.cloudThreadId, "Unknown thread.");
      return;
    }
    try {
      const project = validateRegisteredProject(this.config, mapping.projectName);
      sendCommandAck(input.socket, input.command.commandId, true, input.command.cloudThreadId);
      await this.options.runtimeBridge.startTurn({
        cloudThreadId: input.command.cloudThreadId,
        project,
        prompt: input.command.prompt,
        onStatus: (status) => {
          const next = this.state.upsertThreadMapping({
            cloudThreadId: input.command.cloudThreadId,
            projectName: project.name,
            projectPath: project.path,
            providerThreadId: status.providerThreadId,
            status: status.status,
            activeTurnId: status.activeTurnId,
          });
          sendThreadStatus(input.socket, {
            cloudThreadId: input.command.cloudThreadId,
            projectId: project.name,
            status: status.status,
            ...(next.providerThreadId ? { providerThreadId: next.providerThreadId } : {}),
            ...(next.activeTurnId ? { activeTurnId: next.activeTurnId } : {}),
            lastEventSequence: next.lastLocalSequence,
            ...(status.message ? { message: status.message } : {}),
          });
        },
        onEvent: (event) => {
          this.forwardRuntimeControlEvent({
            socket: input.socket,
            command: {
              commandId: input.command.commandId,
              cloudThreadId: input.command.cloudThreadId,
              projectId: project.name,
              prompt: input.command.prompt,
              requestedAt: input.command.requestedAt,
            },
            project,
            event,
          });
          enqueueRuntimeEvent({
            state: this.state,
            project,
            cloudThreadId: input.command.cloudThreadId,
            event,
          });
          input.flushPending();
        },
      });
      input.flushPending();
    } catch (error) {
      sendCommandAck(
        input.socket,
        input.command.commandId,
        false,
        input.command.cloudThreadId,
        error instanceof Error ? error.message : "Failed to steer turn.",
      );
    }
  }

  private async handleTurnInterruptCommand(input: {
    readonly socket: OutboundWebSocket;
    readonly command: RunnerTurnInterruptPayload;
  }): Promise<void> {
    try {
      await this.options.runtimeBridge.interruptTurn(input.command.cloudThreadId);
      sendCommandAck(input.socket, input.command.commandId, true, input.command.cloudThreadId);
    } catch (error) {
      sendCommandAck(
        input.socket,
        input.command.commandId,
        false,
        input.command.cloudThreadId,
        error instanceof Error ? error.message : "Failed to interrupt turn.",
      );
    }
  }

  private async handleApprovalResolveCommand(input: {
    readonly socket: OutboundWebSocket;
    readonly command: {
      readonly commandId: string;
      readonly approvalId: string;
      readonly cloudThreadId: string;
      readonly decision: ApprovalDecision;
    };
  }): Promise<void> {
    try {
      await this.options.runtimeBridge.resolveApproval(
        input.command.cloudThreadId,
        input.command.approvalId,
        input.command.decision,
      );
      sendCommandAck(input.socket, input.command.commandId, true, input.command.cloudThreadId);
      input.socket.sendJson(
        createEnvelope("runner.approval.resolved", {
          approvalId: input.command.approvalId,
          cloudThreadId: input.command.cloudThreadId,
          decision: input.command.decision,
          resolvedAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      sendCommandAck(
        input.socket,
        input.command.commandId,
        false,
        input.command.cloudThreadId,
        error instanceof Error ? error.message : "Failed to resolve approval.",
      );
    }
  }

  private forwardRuntimeControlEvent(input: {
    readonly socket: OutboundWebSocket;
    readonly command: RunnerTurnStartPayload;
    readonly project: ProjectConfig;
    readonly event: RuntimeEvent;
  }): void {
    const payload = asRecord(input.event.payload);
    if (input.event.type === "codex.approval.requested") {
      const approvalId = typeof payload.approvalId === "string" ? payload.approvalId : `approval_${randomUUID()}`;
      input.socket.sendJson(
        createEnvelope("runner.approval.opened", {
          approvalId,
          cloudThreadId: input.command.cloudThreadId,
          projectId: input.project.name,
          approvalType:
            typeof payload.approvalType === "string" ? payload.approvalType : "unknown",
          payload,
          createdAt: new Date().toISOString(),
        }),
      );
    }
    if (input.event.type === "codex.approval.resolved") {
      const approvalId = typeof payload.approvalId === "string" ? payload.approvalId : undefined;
      const decision = payload.decision;
      if (approvalId && (decision === "accept" || decision === "decline" || decision === "cancel")) {
        input.socket.sendJson(
          createEnvelope("runner.approval.resolved", {
            approvalId,
            cloudThreadId: input.command.cloudThreadId,
            decision,
            resolvedAt: new Date().toISOString(),
          }),
        );
      }
    }
  }
}

function projectDescriptors(config: MacRunnerConfig) {
  return Object.values(config.projects).map((project) => ({
    projectId: project.name,
    name: project.name,
  }));
}

function sendCommandAck(
  socket: OutboundWebSocket,
  commandId: string,
  accepted: boolean,
  cloudThreadId?: string,
  message?: string,
): void {
  socket.sendJson(
    createEnvelope("runner.command.ack", {
      commandId,
      accepted,
      ...(cloudThreadId ? { cloudThreadId } : {}),
      ...(message ? { message } : {}),
    }),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function enqueueRuntimeEvent(input: {
  readonly state: RunnerStateDatabase;
  readonly project: ProjectConfig;
  readonly cloudThreadId: string;
  readonly event: RuntimeEvent;
}): void {
  input.state.enqueueRuntimeEvent({
    projectName: input.project.name,
    projectPath: input.project.path,
    threadId: input.cloudThreadId,
    type: input.event.type,
    payload: input.event.payload,
  });
}

function sendThreadStatus(socket: OutboundWebSocket, payload: RunnerThreadStatusPayload): void {
  socket.sendJson(createEnvelope("runner.thread.status", payload));
}

function sendQueuedEvent(
  socket: OutboundWebSocket,
  state: RunnerStateDatabase,
  event: QueuedEvent,
): void {
  state.markAttempted(event.eventId);
  const payload: RunnerEventAppendPayload = {
    eventId: event.eventId,
    projectId: event.projectName,
    threadId: event.threadId,
    type: event.type,
    payload:
      event.localSequence !== null
        ? {
            localSequence: event.localSequence,
            data: event.payload,
          }
        : event.payload,
    occurredAt: event.occurredAt,
  };
  socket.sendJson(createEnvelope("runner.event.append", payload, { id: event.eventId }));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for cloud-server.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
