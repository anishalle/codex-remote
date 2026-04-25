import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { Duration, Effect, Layer, Option, Schedule } from "effect";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { LOCAL_BRIDGE_SERVER_STARTED_AT_MS } from "./localBridgeTiming.ts";

const CODEX_CLI_PROJECT_ID_PREFIX = "codex-cli-project:";
const CODEX_CLI_THREAD_ID_PREFIX = "codex-cli:";
const CODEX_CLI_COMMAND_ID_PREFIX = "server:codex-cli-import:";
const CODEX_CLI_IMPORT_RUNTIME_SOURCE = "codex-cli-import";
const CODEX_CLI_SCAN_INTERVAL = Duration.seconds(2);
const STARTUP_LOOKBACK_MS = 10 * 60_000;
const CODEX_CLI_ACTIVE_WINDOW_MS = 30_000;
const MAX_TITLE_LENGTH = 80;
const MAX_TOOL_TEXT_LENGTH = 20_000;

export interface ImportedCodexCliMessage {
  readonly messageId: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ParsedCodexCliSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly sessionStartedAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<ImportedCodexCliMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

export interface LoadedCodexCliSession {
  readonly filePath: string;
  readonly contents: string;
  readonly updatedAt: string;
  readonly session: ParsedCodexCliSession;
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

function readResumeCursorThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawThreadId = (resumeCursor as { readonly threadId?: unknown }).threadId;
  return typeof rawThreadId === "string" && rawThreadId.trim().length > 0
    ? rawThreadId.trim()
    : undefined;
}

function readRuntimePayloadSource(runtimePayload: unknown): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawSource = (runtimePayload as { readonly source?: unknown }).source;
  return typeof rawSource === "string" && rawSource.trim().length > 0 ? rawSource.trim() : undefined;
}

function inferCodexCliSessionStatus(
  updatedAt: string,
): "running" | "ready" {
  const updatedAtMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedAtMs)) {
    return "ready";
  }
  return Date.now() - updatedAtMs <= CODEX_CLI_ACTIVE_WINDOW_MS ? "running" : "ready";
}

function shouldReviveArchivedCodexCliThread(input: {
  readonly archivedAt: string | null;
  readonly sessionUpdatedAt: string;
  readonly sessionStatus: "running" | "ready";
}): boolean {
  if (input.archivedAt === null) {
    return false;
  }
  if (input.sessionStatus === "running") {
    return true;
  }
  const archivedAtMs = Date.parse(input.archivedAt);
  const updatedAtMs = Date.parse(input.sessionUpdatedAt);
  if (Number.isNaN(archivedAtMs) || Number.isNaN(updatedAtMs)) {
    return false;
  }
  return updatedAtMs > archivedAtMs;
}

function isCodexCliImportBinding(
  sessionId: string,
  binding: ProviderRuntimeBinding | undefined,
): boolean {
  if (!binding || binding.provider !== "codex") {
    return false;
  }
  if (readResumeCursorThreadId(binding.resumeCursor) !== sessionId) {
    return false;
  }
  return readRuntimePayloadSource(binding.runtimePayload) === CODEX_CLI_IMPORT_RUNTIME_SOURCE;
}

export function shouldImportCodexCliTranscript(
  sessionId: string,
  binding: ProviderRuntimeBinding | undefined,
): boolean {
  if (!binding || binding.provider !== "codex") {
    return true;
  }
  if (readResumeCursorThreadId(binding.resumeCursor) !== sessionId) {
    return true;
  }
  return readRuntimePayloadSource(binding.runtimePayload) === CODEX_CLI_IMPORT_RUNTIME_SOURCE;
}

function codexCliMessageId(sessionId: string, sourceIndex: number): MessageId {
  return MessageId.make(`${CODEX_CLI_THREAD_ID_PREFIX}${sessionId}:msg:${sourceIndex}`);
}

function codexCliActivityId(sessionId: string, sourceIndex: number): EventId {
  return EventId.make(`${CODEX_CLI_THREAD_ID_PREFIX}${sessionId}:activity:${sourceIndex}`);
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

function parseJsonValue(input: string | undefined): unknown {
  if (input === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function truncateToolText(input: string | undefined): {
  readonly text: string | undefined;
  readonly truncated: boolean;
} {
  if (input === undefined) {
    return { text: undefined, truncated: false };
  }
  if (input.length <= MAX_TOOL_TEXT_LENGTH) {
    return { text: input, truncated: false };
  }
  return {
    text: `${input.slice(0, MAX_TOOL_TEXT_LENGTH).trimEnd()}\n\n[truncated]`,
    truncated: true,
  };
}

function normalizeToolName(name: string): string {
  return name.replace(/^functions\./, "");
}

function truncateSingleLine(input: string, maxLength: number): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function toolDetail(name: string, args: unknown, input: string | undefined): string | undefined {
  if (name === "exec_command" && isRecord(args)) {
    const command = readString(args, "cmd");
    return command;
  }

  if (name === "apply_patch" && input !== undefined) {
    const interestingLine = input
      .split("\n")
      .map((line) => line.trim())
      .find(
        (line) =>
          line.startsWith("*** Add File:") ||
          line.startsWith("*** Update File:") ||
          line.startsWith("*** Delete File:") ||
          line.startsWith("*** Move to:"),
      );
    return interestingLine ?? "patch";
  }

  if (name === "multi_tool_use.parallel" && isRecord(args) && Array.isArray(args.tool_uses)) {
    return `${args.tool_uses.length} tool calls`;
  }

  return undefined;
}

function buildToolSummary(name: string, detail: string | undefined): string {
  const normalizedName = normalizeToolName(name);
  return detail === undefined
    ? normalizedName
    : `${normalizedName}: ${truncateSingleLine(detail, 120)}`;
}

interface ParsedToolCall {
  readonly sourceIndex: number;
  readonly callId: string;
  readonly name: string;
  readonly argumentsText: string | undefined;
  readonly input: string | undefined;
  readonly status: string | undefined;
  readonly createdAt: string;
}

interface ParsedToolOutput {
  readonly sourceIndex: number;
  readonly output: string;
  readonly createdAt: string;
}

function buildToolActivity(
  sessionId: string,
  call: ParsedToolCall,
  output: ParsedToolOutput | undefined,
): OrchestrationThreadActivity {
  const args = parseJsonValue(call.argumentsText);
  const outputValue = parseJsonValue(output?.output);
  const inputText = truncateToolText(call.input);
  const outputText = truncateToolText(
    typeof outputValue === "string" ? outputValue : output?.output,
  );
  const detail = toolDetail(call.name, args, call.input);

  return {
    id: codexCliActivityId(sessionId, call.sourceIndex),
    tone: "tool",
    kind: "codex-cli.tool",
    summary: buildToolSummary(call.name, detail),
    payload: {
      source: "codex-cli",
      itemType: normalizeToolName(call.name),
      callId: call.callId,
      status: call.status ?? "completed",
      ...(detail !== undefined ? { detail } : {}),
      ...(args !== undefined ? { arguments: args } : {}),
      ...(inputText.text !== undefined
        ? { input: inputText.text, inputTruncated: inputText.truncated }
        : {}),
      ...(output !== undefined
        ? {
            output:
              typeof outputValue === "string"
                ? outputText.text
                : outputValue ?? outputText.text,
            outputTruncated: outputText.truncated,
            outputCreatedAt: output.createdAt,
            outputSourceIndex: output.sourceIndex,
          }
        : {}),
    },
    turnId: null,
    sequence: call.sourceIndex,
    createdAt: call.createdAt,
  };
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
  const toolCalls: ParsedToolCall[] = [];
  const toolOutputs = new Map<string, ParsedToolOutput>();

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
      (envelope.payload.type === "function_call" ||
        envelope.payload.type === "custom_tool_call") &&
      isRecord(envelope.payload)
    ) {
      const callId = readString(envelope.payload, "call_id");
      const name = readString(envelope.payload, "name");
      if (callId !== undefined && name !== undefined) {
        const createdAt = readEnvelopeTimestamp(envelope, input.updatedAt);
        toolCalls.push({
          sourceIndex,
          callId,
          name,
          argumentsText: readString(envelope.payload, "arguments"),
          input: readString(envelope.payload, "input"),
          status: readString(envelope.payload, "status"),
          createdAt,
        });
      }
      continue;
    }

    if (
      envelope.type === "response_item" &&
      (envelope.payload.type === "function_call_output" ||
        envelope.payload.type === "custom_tool_call_output") &&
      isRecord(envelope.payload)
    ) {
      const callId = readString(envelope.payload, "call_id");
      const output = readString(envelope.payload, "output");
      if (callId !== undefined && output !== undefined) {
        toolOutputs.set(callId, {
          sourceIndex,
          output,
          createdAt: readEnvelopeTimestamp(envelope, input.updatedAt),
        });
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
    activities: toolCalls.map((call) =>
      buildToolActivity(sessionId, call, toolOutputs.get(call.callId)),
    ),
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

export async function loadUpdatedCodexCliSessionsFromDisk(input: {
  readonly root: string;
  readonly updatedSinceMs: number;
}): Promise<ReadonlyArray<LoadedCodexCliSession>> {
  const files = await collectCodexSessionFiles(input.root);
  const sessions: LoadedCodexCliSession[] = [];

  for (const filePath of files) {
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(filePath);
    } catch {
      continue;
    }
    if (fileStat.mtimeMs < input.updatedSinceMs) {
      continue;
    }

    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const updatedAt = fileStat.mtime.toISOString();
    const session = parseCodexCliSessionJsonl({
      filePath,
      contents,
      updatedAt,
    });
    if (session !== null) {
      sessions.push({
        filePath,
        contents,
        updatedAt,
        session,
      });
    }
  }

  return sessions;
}

const loadUpdatedCodexSessions = Effect.fn("loadUpdatedCodexSessions")(function* (input: {
  readonly root: string;
  readonly updatedSinceMs: number;
}) {
  const loaded = yield* Effect.tryPromise(() => loadUpdatedCodexCliSessionsFromDisk(input));
  return loaded.map((entry) => entry.session);
});

export const importCodexCliSessionReadModel = Effect.fn("importCodexCliSessionReadModel")(function* (
  session: ParsedCodexCliSession,
) {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const desiredSessionStatus = inferCodexCliSessionStatus(session.updatedAt);
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
  if (
    shouldReviveArchivedCodexCliThread({
      archivedAt: afterThread?.archivedAt ?? null,
      sessionUpdatedAt: session.updatedAt,
      sessionStatus: desiredSessionStatus,
    })
  ) {
    yield* orchestrationEngine.dispatch({
      type: "thread.unarchive",
      commandId: commandId("thread-unarchive"),
      threadId,
    });
  }

  const existingBinding = Option.getOrUndefined(
    yield* providerSessionDirectory.getBinding(threadId),
  );
  if (!shouldImportCodexCliTranscript(session.sessionId, existingBinding)) {
    return {
      projectId,
      threadId,
    };
  }

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

  const afterMessagesReadModel = yield* orchestrationEngine.getReadModel();
  const afterMessagesThread = afterMessagesReadModel.threads.find((thread) => thread.id === threadId);
  const existingActivities = new Map(
    afterMessagesThread?.activities.map((activity) => [activity.id, activity]) ?? [],
  );
  for (const activity of session.activities) {
    const existingActivity = existingActivities.get(activity.id);
    if (existingActivity !== undefined && JSON.stringify(existingActivity) === JSON.stringify(activity)) {
      continue;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: commandId("activity"),
      threadId,
      activity,
      createdAt: activity.createdAt,
    });
  }

  const latestReadModel = yield* orchestrationEngine.getReadModel();
  const latestThread = latestReadModel.threads.find((thread) => thread.id === threadId);
  if (
    latestThread?.session?.updatedAt !== session.updatedAt ||
    latestThread.session?.status !== desiredSessionStatus
  ) {
    yield* orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: commandId("thread-session"),
      threadId,
      session: {
        threadId,
        status: desiredSessionStatus,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: session.updatedAt,
      },
      createdAt: session.updatedAt,
    });
  }

  return {
    projectId,
    threadId,
  };
});

export const importCodexCliSession = Effect.fn("importCodexCliSession")(function* (
  session: ParsedCodexCliSession,
) {
  const imported = yield* importCodexCliSessionReadModel(session);
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const desiredSessionStatus = inferCodexCliSessionStatus(session.updatedAt);
  const threadId = imported.threadId;

  const existingBinding = yield* providerSessionDirectory.getBinding(threadId);
  const binding = Option.getOrUndefined(existingBinding);
  if (binding?.resumeCursor !== undefined && binding.resumeCursor !== null) {
    if (!isCodexCliImportBinding(session.sessionId, binding)) {
      return;
    }
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
      source: CODEX_CLI_IMPORT_RUNTIME_SOURCE,
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
        Effect.forEach(sessions, (session) => importCodexCliSession(session), {
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
