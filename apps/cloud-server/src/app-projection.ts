import type {
  AppActivity,
  AppApproval,
  AppMessage,
  AppSession,
  AppSnapshot,
  AppThreadDetail,
  AppThreadSummary,
  CloudEvent,
  PendingApprovalSummary,
  ThreadSummary,
} from "../../../packages/protocol/src/index.ts";
import type { AuthenticatedSession } from "./auth.ts";
import type { CloudDatabase } from "./db.ts";

const THREAD_EVENT_PAGE_SIZE = 500;
const THREAD_EVENT_MAX_PAGES = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toAppSession(session: AuthenticatedSession): AppSession {
  return {
    authenticated: true,
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    deviceKind: session.deviceKind,
    deviceName: session.deviceName,
    expiresAt: session.expiresAt,
  };
}

function normalizePayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  const data = payload.data;
  if (isRecord(data)) return data;
  return payload;
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (isRecord(current) && part in current) return current[part];
    return undefined;
  }, value);
}

function firstString(value: unknown, paths: readonly string[]): string {
  for (const path of paths) {
    const found = getPath(value, path);
    if (typeof found === "string" && found.trim().length > 0) return found.trim();
  }
  return "";
}

function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(flattenText).filter(Boolean).join("");
  }
  if (!isRecord(value)) return "";
  const direct = firstString(value, ["text", "message", "delta", "content"]);
  if (direct) return direct;
  if (Array.isArray(value.content)) return flattenText(value.content);
  if (Array.isArray(value.items)) return flattenText(value.items);
  return "";
}

function eventMethod(event: CloudEvent, data: Record<string, unknown>): string {
  return typeof data.method === "string" ? data.method : event.type;
}

function titleize(value: string): string {
  return value
    .replace(/^codex\./, "")
    .replace(/^mock\./, "")
    .replace(/[._/-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function compactId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function compactText(value: string, maxLength = 76): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function commandFromPayload(data: Record<string, unknown>): string {
  return firstString(data, [
    "params.command",
    "params.item.command",
    "params.cmd",
    "params.arguments.command",
    "params.arguments.cmd",
    "params.input",
    "command",
    "cmd",
  ]);
}

function firstRawString(value: unknown, paths: readonly string[]): string {
  for (const path of paths) {
    const found = getPath(value, path);
    if (typeof found === "string" && found.length > 0) return found;
  }
  return "";
}

function stringifyCommand(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function commandTextFromPayload(data: Record<string, unknown>): string {
  return (
    commandFromPayload(data) ||
    stringifyCommand(getPath(data, "params.item.command")) ||
    stringifyCommand(getPath(data, "params.command"))
  );
}

function itemIdFromPayload(data: Record<string, unknown>, fallback: string): string {
  return (
    firstString(data, [
      "params.itemId",
      "params.item.id",
      "params.message.id",
      "itemId",
      "item.id",
    ]) || fallback
  );
}

function itemTypeFromPayload(data: Record<string, unknown>): string {
  return firstString(data, ["params.item.type", "params.type", "item.type"]);
}

function commandOutputFromPayload(data: Record<string, unknown>): string {
  return (
    flattenText(getPath(data, "params.item.aggregatedOutput")) ||
    flattenText(getPath(data, "params.item.output")) ||
    firstString(data, ["params.item.stderr", "params.item.stdout", "params.output"])
  );
}

type MutableMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  updatedAt: string;
  sequence?: number;
  streaming?: boolean;
};

type MutableActivity = {
  id: string;
  kind: "status" | "tool" | "approval" | "error" | "raw";
  tone: "info" | "thinking" | "tool" | "approval" | "error";
  label: string;
  detail?: string;
  createdAt: string;
  sequence?: number;
};

function approvalTitle(approvalType: string): string {
  if (approvalType === "command") return "Command approval";
  if (approvalType === "file-change") return "File change approval";
  if (approvalType === "file-read") return "File read approval";
  return `${titleize(approvalType)} approval`;
}

export function toAppApproval(approval: PendingApprovalSummary): AppApproval {
  const data = normalizePayload(approval.payload);
  const command = commandFromPayload(data);
  const detail =
    firstString(data, [
      "params.reason",
      "params.description",
      "params.path",
      "params.filePath",
      "reason",
      "description",
      "path",
      "filePath",
    ]) || (command ? compactText(command, 120) : undefined);
  return {
    approvalId: approval.approvalId,
    runnerId: approval.runnerId,
    cloudThreadId: approval.cloudThreadId,
    projectId: approval.projectId,
    approvalType: approval.approvalType,
    status: approval.status,
    title: approvalTitle(approval.approvalType),
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(approval.decision ? { decision: approval.decision } : {}),
    createdAt: approval.createdAt,
    ...(approval.resolvedAt ? { resolvedAt: approval.resolvedAt } : {}),
  };
}

function messageFromEvent(event: CloudEvent): AppMessage | null {
  const data = normalizePayload(event.payload);
  if (event.type === "client.prompt.submitted") {
    const text = firstString(data, ["text", "prompt", "message"]);
    if (!text) return null;
    return {
      id: `msg_${event.sequence}`,
      role: "user",
      text,
      createdAt: event.occurredAt,
      updatedAt: event.receivedAt,
      sequence: event.sequence,
    };
  }

  const method = eventMethod(event, data).toLowerCase();
  const role = firstString(data, ["role", "params.role", "params.message.role"]);
  const messageText =
    firstString(data, [
      "text",
      "message",
      "delta",
      "params.text",
      "params.message",
      "params.delta",
      "params.item.text",
      "params.item.message",
      "params.item.delta",
      "params.message.text",
      "params.message.content",
    ]) ||
    flattenText(getPath(data, "params.item.content")) ||
    flattenText(getPath(data, "params.message.content"));

  if (!messageText) return null;
  if (
    event.type.includes("output.message") ||
    event.type.includes("message") ||
    method.includes("message") ||
    method.includes("content") ||
    role === "assistant"
  ) {
    return {
      id: `msg_${event.sequence}`,
      role: role === "user" || role === "system" ? role : "assistant",
      text: messageText,
      createdAt: event.occurredAt,
      updatedAt: event.receivedAt,
      sequence: event.sequence,
      streaming: method.includes("delta"),
    };
  }

  return null;
}

function activityFromEvent(event: CloudEvent): AppActivity | null {
  const data = normalizePayload(event.payload);
  const method = eventMethod(event, data);
  const lower = `${event.type} ${method}`.toLowerCase();

  if (event.type === "client.prompt.submitted" || messageFromEvent(event)) {
    return null;
  }

  if (event.type === "codex.thread.started") {
    const workspaceRoot = firstString(data, ["workspaceRoot"]);
    return {
      id: `activity_${event.sequence}`,
      kind: "status",
      tone: "info",
      label: "Thread started",
      ...(workspaceRoot ? { detail: workspaceRoot } : {}),
      createdAt: event.occurredAt,
      sequence: event.sequence,
    };
  }

  if (event.type === "codex.turn.requested") {
    const promptLength = getPath(data, "promptLength");
    return {
      id: `activity_${event.sequence}`,
      kind: "status",
      tone: "thinking",
      label: "Turn requested",
      detail:
        typeof promptLength === "number" ? `${promptLength.toLocaleString()} prompt characters` : undefined,
      createdAt: event.occurredAt,
      sequence: event.sequence,
    };
  }

  if (lower.includes("approval")) {
    const detail = firstString(data, ["approvalType", "method", "decision"]);
    return {
      id: `activity_${event.sequence}`,
      kind: "approval",
      tone: "approval",
      label: lower.includes("resolved") ? "Approval resolved" : "Approval requested",
      ...(detail ? { detail } : {}),
      createdAt: event.occurredAt,
      sequence: event.sequence,
    };
  }

  if (lower.includes("stderr") || lower.includes("error")) {
    return {
      id: `activity_${event.sequence}`,
      kind: "error",
      tone: "error",
      label: "Runtime error",
      detail: firstString(data, ["message", "error.message", "params.error.message"]) || titleize(method),
      createdAt: event.occurredAt,
      sequence: event.sequence,
    };
  }

  if (event.type === "codex.notification") {
    return {
      id: `activity_${event.sequence}`,
      kind: lower.includes("turn") || lower.includes("thread") ? "status" : "tool",
      tone: lower.includes("turn/started") ? "thinking" : "info",
      label: titleize(method),
      detail: firstString(data, ["params.status", "params.name", "params.title"]),
      createdAt: event.occurredAt,
      sequence: event.sequence,
    };
  }

  if (event.type === "codex.request") {
    return {
      id: `activity_${event.sequence}`,
      kind: "tool",
      tone: "tool",
      label: titleize(method),
      detail: commandFromPayload(data) || firstString(data, ["params.path", "params.filePath"]),
      createdAt: event.occurredAt,
      sequence: event.sequence,
    };
  }

  if (event.type === "mock.codex.turn.started") {
    return {
      id: `activity_${event.sequence}`,
      kind: "status",
      tone: "thinking",
      label: "Mock turn started",
      detail: firstString(data, ["workspaceRoot", "projectName"]),
      createdAt: event.occurredAt,
      sequence: event.sequence,
    };
  }

  return {
    id: `activity_${event.sequence}`,
    kind: "raw",
    tone: "info",
    label: titleize(event.type),
    detail: firstString(data, ["message", "method", "status", "name", "projectName"]),
    createdAt: event.occurredAt,
    sequence: event.sequence,
  };
}

function buildThreadProjection(events: readonly CloudEvent[]): {
  readonly messages: readonly AppMessage[];
  readonly activities: readonly AppActivity[];
} {
  const messages: MutableMessage[] = [];
  const assistantByItemId = new Map<string, MutableMessage>();
  const activitiesByItemId = new Map<string, MutableActivity>();

  const upsertAssistantMessage = (input: {
    readonly key: string;
    readonly event: CloudEvent;
    readonly text: string;
    readonly append: boolean;
    readonly streaming: boolean;
  }) => {
    const existing = assistantByItemId.get(input.key);
    if (existing) {
      existing.text = input.append ? `${existing.text}${input.text}` : input.text;
      existing.updatedAt = input.event.receivedAt;
      existing.sequence = input.event.sequence;
      existing.streaming = input.streaming;
      return;
    }
    const next: MutableMessage = {
      id: `assistant_${input.key}`,
      role: "assistant",
      text: input.text,
      createdAt: input.event.occurredAt,
      updatedAt: input.event.receivedAt,
      sequence: input.event.sequence,
      streaming: input.streaming,
    };
    assistantByItemId.set(input.key, next);
    messages.push(next);
  };

  const upsertCommandActivity = (input: {
    readonly key: string;
    readonly event: CloudEvent;
    readonly label: string;
    readonly tone: "info" | "thinking" | "tool" | "error";
    readonly detail?: string;
  }) => {
    const existing = activitiesByItemId.get(input.key);
    if (existing) {
      existing.label = input.label;
      existing.tone = input.tone;
      existing.detail = input.detail;
      existing.sequence = input.event.sequence;
      return;
    }
    const next: MutableActivity = {
      id: `activity_${input.key}`,
      kind: input.tone === "error" ? "error" : "tool",
      tone: input.tone,
      label: input.label,
      ...(input.detail ? { detail: input.detail } : {}),
      createdAt: input.event.occurredAt,
      sequence: input.event.sequence,
    };
    activitiesByItemId.set(input.key, next);
  };

  for (const event of events) {
    const data = normalizePayload(event.payload);
    if (event.type === "client.prompt.submitted") {
      const text = firstString(data, ["text", "prompt", "message"]);
      if (text) {
        messages.push({
          id: `msg_${event.sequence}`,
          role: "user",
          text,
          createdAt: event.occurredAt,
          updatedAt: event.receivedAt,
          sequence: event.sequence,
        });
      }
      continue;
    }

    if (event.type === "codex.notification") {
      const method = eventMethod(event, data);
      const itemType = itemTypeFromPayload(data);
      const itemId = itemIdFromPayload(data, `seq_${event.sequence}`);

      if (method === "item/agentMessage/delta") {
        const delta =
          firstRawString(data, ["params.delta", "params.item.delta", "delta"]) ||
          flattenText(getPath(data, "params.item.content"));
        if (delta) {
          upsertAssistantMessage({
            key: itemId,
            event,
            text: delta,
            append: true,
            streaming: true,
          });
        }
        continue;
      }

      if (itemType === "agentMessage") {
        const text =
          firstRawString(data, ["params.item.text", "params.text", "text"]) ||
          flattenText(getPath(data, "params.item.content"));
        if (text) {
          upsertAssistantMessage({
            key: itemId,
            event,
            text,
            append: false,
            streaming: method !== "item/completed",
          });
        }
        continue;
      }

      if (itemType === "commandExecution") {
        const command = commandTextFromPayload(data);
        const output = commandOutputFromPayload(data);
        const status = firstString(data, ["params.item.status", "params.status"]);
        const failed = status === "failed" || status === "error";
        const detail = [command, output ? compactText(output, 220) : ""].filter(Boolean).join("\n");
        upsertCommandActivity({
          key: itemId,
          event,
          label: method === "item/completed" ? (failed ? "Command failed" : "Command completed") : "Running command",
          tone: method === "item/completed" ? (failed ? "error" : "tool") : "thinking",
          ...(detail ? { detail } : {}),
        });
        continue;
      }

      if (itemType === "reasoning" || itemType === "userMessage") continue;
      if (
        method === "thread/started" ||
        method === "thread/status/changed" ||
        method === "turn/started" ||
        method === "turn/completed" ||
        method === "mcpServer/startupStatus/updated" ||
        method === "account/rateLimits/updated" ||
        method === "item/started" ||
        method === "item/completed"
      ) {
        continue;
      }
    }

    if (event.type === "codex.stderr") {
      const activity = activityFromEvent(event);
      if (activity) activitiesByItemId.set(`stderr_${event.sequence}`, { ...activity });
      continue;
    }

    if (event.type === "codex.request") {
      const data = normalizePayload(event.payload);
      const detail = commandTextFromPayload(data) || firstString(data, ["params.path", "params.filePath"]);
      if (detail) {
        activitiesByItemId.set(`request_${event.sequence}`, {
          id: `activity_${event.sequence}`,
          kind: "tool",
          tone: "tool",
          label: titleize(eventMethod(event, data)),
          detail,
          createdAt: event.occurredAt,
          sequence: event.sequence,
        });
      }
      continue;
    }

    if (event.type.startsWith("mock.")) {
      const message = messageFromEvent(event);
      if (message) {
        messages.push({ ...message });
      }
    }
  }

  return {
    messages: messages.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0)),
    activities: Array.from(activitiesByItemId.values()).sort(
      (left, right) => (left.sequence ?? 0) - (right.sequence ?? 0),
    ),
  };
}

function listThreadEvents(db: CloudDatabase, threadId: string): CloudEvent[] {
  const events: CloudEvent[] = [];
  let afterSequence = 0;
  for (let page = 0; page < THREAD_EVENT_MAX_PAGES; page += 1) {
    const next = db.listEvents({
      threadId,
      afterSequence,
      limit: THREAD_EVENT_PAGE_SIZE,
    });
    if (next.length === 0) break;
    events.push(...next);
    afterSequence = Math.max(...next.map((event) => event.sequence));
    if (next.length < THREAD_EVENT_PAGE_SIZE) break;
  }
  return events;
}

function buildThreadSummary(input: {
  readonly thread: ThreadSummary;
  readonly events: readonly CloudEvent[];
  readonly approvals: readonly AppApproval[];
}): AppThreadSummary {
  const { messages, activities } = buildThreadProjection(input.events);
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const latestAssistantMessage = [...messages].reverse().find((message) => message.role === "assistant");
  const latestActivity = activities.at(-1);
  return {
    id: input.thread.cloudThreadId,
    cloudThreadId: input.thread.cloudThreadId,
    runnerId: input.thread.runnerId,
    projectId: input.thread.projectId,
    title: latestUserMessage?.text ? compactText(latestUserMessage.text) : input.thread.projectId,
    status: input.thread.status,
    ...(input.thread.providerThreadId ? { providerThreadId: input.thread.providerThreadId } : {}),
    ...(input.thread.activeTurnId ? { activeTurnId: input.thread.activeTurnId } : {}),
    createdAt: input.thread.createdAt,
    updatedAt: input.thread.updatedAt,
    ...(latestUserMessage ? { latestUserMessageAt: latestUserMessage.createdAt } : {}),
    ...(latestAssistantMessage ? { latestAssistantMessageAt: latestAssistantMessage.createdAt } : {}),
    ...(latestActivity ? { lastActivityLabel: latestActivity.label } : {}),
    hasPendingApprovals: input.approvals.some(
      (approval) => approval.cloudThreadId === input.thread.cloudThreadId && approval.status === "pending",
    ),
    eventCount: input.events.length,
  };
}

export function buildAppThreadDetail(input: {
  readonly db: CloudDatabase;
  readonly cloudThreadId: string;
}): AppThreadDetail {
  const thread = input.db.getThread(input.cloudThreadId);
  if (!thread) {
    return {
      thread: null,
      messages: [],
      activities: [],
      approvals: [],
      rawEventCount: 0,
      lastSequence: 0,
    };
  }

  const events = listThreadEvents(input.db, thread.cloudThreadId);
  const approvals = input.db
    .listApprovals({ threadId: thread.cloudThreadId })
    .map(toAppApproval);
  const projection = buildThreadProjection(events);
  return {
    thread: buildThreadSummary({ thread, events, approvals }),
    messages: projection.messages,
    activities: projection.activities,
    approvals,
    rawEventCount: events.length,
    lastSequence: events.reduce((max, event) => Math.max(max, event.sequence), 0),
  };
}

export function buildAppSnapshot(input: {
  readonly db: CloudDatabase;
  readonly session: AuthenticatedSession;
}): AppSnapshot {
  const threads = input.db.listThreads({ limit: 200 });
  const approvals = input.db.listApprovals({ status: "pending" }).map(toAppApproval);
  let lastSequence = 0;
  const appThreads = threads.map((thread) => {
    const events = listThreadEvents(input.db, thread.cloudThreadId);
    lastSequence = Math.max(
      lastSequence,
      thread.lastEventSequence ?? 0,
      events.reduce((max, event) => Math.max(max, event.sequence), 0),
    );
    return buildThreadSummary({ thread, events, approvals });
  });

  return {
    session: toAppSession(input.session),
    runners: input.db.listRunners(),
    projects: input.db.listProjects(),
    threads: appThreads,
    approvals,
    lastSequence,
  };
}

export function shortThreadLabel(thread: ThreadSummary | null): string {
  return thread ? `${thread.projectId} ${compactId(thread.cloudThreadId)}` : "Unknown thread";
}
