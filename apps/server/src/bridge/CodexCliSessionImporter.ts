import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { Duration, Effect, Layer, Option, Schedule } from "effect";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { LOCAL_BRIDGE_SERVER_STARTED_AT_MS } from "./localBridgeTiming.ts";

const CODEX_CLI_PROJECT_ID_PREFIX = "codex-cli-project:";
const CODEX_CLI_THREAD_ID_PREFIX = "codex-cli:";
const CODEX_CLI_COMMAND_ID_PREFIX = "server:codex-cli-import:";
const CODEX_CLI_SCAN_INTERVAL = Duration.seconds(2);
const STARTUP_LOOKBACK_MS = 60_000;
const MAX_TITLE_LENGTH = 80;

interface ImportedCodexCliMessage {
  readonly messageId: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ParsedCodexCliSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly sessionStartedAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<ImportedCodexCliMessage>;
}

interface CodexJsonlEnvelope {
  readonly timestamp?: unknown;
  readonly type?: unknown;
  readonly payload?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function truncateTitle(input: string): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "Codex CLI session";
  }
  if (normalized.length <= MAX_TITLE_LENGTH) {
    return normalized;
  }
  return normalized.slice(0, MAX_TITLE_LENGTH - 1).trimEnd();
}

function hashCwd(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export function codexCliProjectIdForCwd(cwd: string): ProjectId {
  return ProjectId.make(`${CODEX_CLI_PROJECT_ID_PREFIX}${hashCwd(cwd)}`);
}

export function codexCliThreadIdForSessionId(sessionId: string): ThreadId {
  return ThreadId.make(`${CODEX_CLI_THREAD_ID_PREFIX}${sessionId}`);
}

function commandId(tag: string): CommandId {
  return CommandId.make(`${CODEX_CLI_COMMAND_ID_PREFIX}${tag}:${crypto.randomUUID()}`);
}

function codexCliMessageId(sessionId: string, sourceIndex: number): MessageId {
  return MessageId.make(`${CODEX_CLI_THREAD_ID_PREFIX}${sessionId}:msg:${sourceIndex}`);
}

function parseEnvelope(line: string): CodexJsonlEnvelope | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readEnvelopeTimestamp(envelope: CodexJsonlEnvelope, fallback: string): string {
  return typeof envelope.timestamp === "string" && envelope.timestamp.trim().length > 0
    ? envelope.timestamp.trim()
    : fallback;
}

function readAssistantResponseText(payload: Record<string, unknown>): string | undefined {
  const content = payload.content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts = content.flatMap((entry) => {
    if (!isRecord(entry) || entry.type !== "output_text") {
      return [];
    }
    const text = readString(entry, "text");
    return text === undefined ? [] : [text];
  });
  const text = parts.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

export function parseCodexCliSessionJsonl(input: {
  readonly filePath: string;
  readonly contents: string;
  readonly updatedAt: string;
}): ParsedCodexCliSession | null {
  let sessionId: string | undefined;
  let sessionStartedAt: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let firstUserMessage: string | undefined;
  const messages: Array<Omit<ImportedCodexCliMessage, "messageId"> & { sourceIndex: number }> = [];

  for (const [sourceIndex, line] of input.contents.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const envelope = parseEnvelope(trimmed);
    if (!envelope || !isRecord(envelope.payload)) {
      continue;
    }

    if (envelope.type === "session_meta") {
      sessionId = readString(envelope.payload, "id") ?? sessionId;
      sessionStartedAt = readString(envelope.payload, "timestamp") ?? sessionStartedAt;
      cwd = readString(envelope.payload, "cwd") ?? cwd;
      continue;
    }

    if (envelope.type === "turn_context") {
      cwd = readString(envelope.payload, "cwd") ?? cwd;
      model = readString(envelope.payload, "model") ?? model;
      continue;
    }

    if (envelope.type === "event_msg" && isRecord(envelope.payload)) {
      if (envelope.payload.type === "user_message" && firstUserMessage === undefined) {
        firstUserMessage = readString(envelope.payload, "message");
      }
      if (envelope.payload.type === "user_message") {
        const text = readString(envelope.payload, "message");
        if (text !== undefined) {
          const createdAt = readEnvelopeTimestamp(envelope, input.updatedAt);
          messages.push({
            sourceIndex,
            role: "user",
            text,
            createdAt,
            updatedAt: createdAt,
          });
        }
      }
      continue;
    }

    if (
      envelope.type === "response_item" &&
      envelope.payload.type === "message" &&
      envelope.payload.role === "assistant"
    ) {
      const text = readAssistantResponseText(envelope.payload);
      if (text !== undefined) {
        const createdAt = readEnvelopeTimestamp(envelope, input.updatedAt);
        messages.push({
          sourceIndex,
          role: "assistant",
          text,
          createdAt,
          updatedAt: createdAt,
        });
      }
    }
  }

  if (!sessionId || !cwd) {
    return null;
  }

  return {
    sessionId,
    cwd,
    title: truncateTitle(firstUserMessage ?? path.basename(cwd) ?? "Codex CLI session"),
    modelSelection: {
      provider: "codex",
      model: model ?? DEFAULT_MODEL_BY_PROVIDER.codex,
    },
    sessionStartedAt: sessionStartedAt ?? input.updatedAt,
    updatedAt: input.updatedAt,
    messages: messages.map(({ sourceIndex, ...message }) => ({
      ...message,
      messageId: codexCliMessageId(sessionId, sourceIndex),
    })),
  };
}

async function collectCodexSessionFiles(root: string): Promise<ReadonlyArray<string>> {
  const collected: string[] = [];

  async function walk(directory: string): Promise<void> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolutePath);
          return;
        }
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          collected.push(absolutePath);
        }
      }),
    );
  }

  await walk(root);
  return collected;
}

const loadUpdatedCodexSessions = Effect.fn("loadUpdatedCodexSessions")(function* (input: {
  readonly root: string;
  readonly updatedSinceMs: number;
}) {
  const files = yield* Effect.tryPromise(() => collectCodexSessionFiles(input.root));
  const sessions: ParsedCodexCliSession[] = [];

  for (const filePath of files) {
    const fileStat = yield* Effect.tryPromise(() => stat(filePath)).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (!fileStat || fileStat.mtimeMs < input.updatedSinceMs) {
      continue;
    }

    const contents = yield* Effect.tryPromise(() => readFile(filePath, "utf8")).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (contents === null) {
      continue;
    }

    const parsed = parseCodexCliSessionJsonl({
      filePath,
      contents,
      updatedAt: fileStat.mtime.toISOString(),
    });
    if (parsed !== null) {
      sessions.push(parsed);
    }
  }

  return sessions;
});

const importSession = Effect.fn("importCodexCliSession")(function* (
  session: ParsedCodexCliSession,
) {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const readModel = yield* orchestrationEngine.getReadModel();
  const existingProject = readModel.projects.find(
    (project) => project.deletedAt === null && project.workspaceRoot === session.cwd,
  );
  const projectId = existingProject?.id ?? codexCliProjectIdForCwd(session.cwd);
  const threadId = codexCliThreadIdForSessionId(session.sessionId);
  const existingThread = readModel.threads.find((thread) => thread.id === threadId);

  if (!existingProject && !readModel.projects.some((project) => project.id === projectId)) {
    yield* orchestrationEngine.dispatch({
      type: "project.create",
      commandId: commandId("project"),
      projectId,
      title: path.basename(session.cwd) || "project",
      workspaceRoot: session.cwd,
      defaultModelSelection: session.modelSelection,
      createdAt: session.updatedAt,
    });
  }

  if (!existingThread) {
    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: commandId("thread"),
      threadId,
      projectId,
      title: session.title,
      modelSelection: session.modelSelection,
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: session.updatedAt,
    });
  }

  const afterThreadReadModel = yield* orchestrationEngine.getReadModel();
  const afterThread = afterThreadReadModel.threads.find((thread) => thread.id === threadId);
  const existingMessages = new Map(afterThread?.messages.map((message) => [message.id, message]));
  for (const message of session.messages) {
    const existingMessage = existingMessages.get(message.messageId);
    if (
      existingMessage?.role === message.role &&
      existingMessage.text === message.text &&
      existingMessage.streaming === false &&
      existingMessage.updatedAt === message.updatedAt
    ) {
      continue;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.message.import",
      commandId: commandId("message"),
      threadId,
      message: {
        id: message.messageId,
        role: message.role,
        text: message.text,
        turnId: null,
        streaming: false,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
      createdAt: message.updatedAt,
    });
  }

  const latestReadModel = yield* orchestrationEngine.getReadModel();
  const latestThread = latestReadModel.threads.find((thread) => thread.id === threadId);
  if (latestThread?.session?.updatedAt !== session.updatedAt) {
    yield* orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: commandId("thread-session"),
      threadId,
      session: {
        threadId,
        status: "ready",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: session.updatedAt,
      },
      createdAt: session.updatedAt,
    });
  }

  const existingBinding = yield* providerSessionDirectory.getBinding(threadId);
  const binding = Option.getOrUndefined(existingBinding);
  if (binding?.resumeCursor !== undefined && binding.resumeCursor !== null) {
    return;
  }

  yield* providerSessionDirectory.upsert({
    threadId,
    provider: "codex",
    runtimeMode: "full-access",
    status: "running",
    resumeCursor: { threadId: session.sessionId },
    runtimePayload: {
      cwd: session.cwd,
      model: session.modelSelection.model,
      modelSelection: session.modelSelection,
      source: "codex-cli-import",
      importedAt: new Date().toISOString(),
    },
  });
});

export const CodexCliSessionImporterLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (!config.localBridge) {
      return;
    }

    const root = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
    const sessionsRoot = path.join(root, "sessions");
    const updatedSinceMs = LOCAL_BRIDGE_SERVER_STARTED_AT_MS - STARTUP_LOOKBACK_MS;

    const sync = loadUpdatedCodexSessions({ root: sessionsRoot, updatedSinceMs }).pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach(sessions, importSession, {
          concurrency: 4,
          discard: true,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("codex cli session import failed", {
          sessionsRoot,
          cause,
        }),
      ),
    );

    yield* Effect.forkScoped(sync.pipe(Effect.repeat(Schedule.spaced(CODEX_CLI_SCAN_INTERVAL))));
  }),
);
