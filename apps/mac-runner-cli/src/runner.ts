import { randomUUID } from "node:crypto";

import {
  ServerMessageSchema,
  createEnvelope,
  parseJson,
  type RunnerEventAppendPayload,
} from "../../../packages/protocol/src/index.ts";
import {
  requireServerUrl,
  requireSessionToken,
  toRunnerWebSocketUrl,
  type MacRunnerConfig,
  type ProjectConfig,
} from "./config.ts";
import { RunnerStateDatabase, type QueuedEvent } from "./state.ts";
import { connectOutboundWebSocket, type OutboundWebSocket } from "./ws-client.ts";

export const MAC_RUNNER_VERSION = "0.2.0";

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
  readonly config: MacRunnerConfig;
  readonly state: RunnerStateDatabase;
  readonly options: Required<Omit<DaemonOptions, "signal" | "logger">> & {
    readonly signal?: AbortSignal;
    readonly logger: RunnerLogger;
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
    };
  }

  async run(): Promise<void> {
    let reconnectDelay = this.options.reconnectBaseMs;
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
          if (message.type === "error") {
            this.options.logger.warn(`cloud-server error: ${message.payload.code}`);
          }
        };
        socket.sendJson(
          createEnvelope("runner.hello", {
            runnerId: this.config.runnerId,
            name: this.config.runnerName,
            version: MAC_RUNNER_VERSION,
            capabilities: ["mock-events", "queue-backfill"],
          }),
        );
      });
    } finally {
      clearInterval(heartbeat);
      clearInterval(flush);
      socket.close();
    }
  }
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
    payload: event.payload,
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
