import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ClientToServerMessageSchema,
  RunnerToServerMessageSchema,
  createEnvelope,
  createErrorEnvelope,
  parseJson,
  type ApprovalDecision,
  type CloudEvent,
  type PendingApprovalSummary,
  type RunnerProjectCreatePayload,
  type RunnerApprovalResolvePayload,
  type RunnerWorkspaceUnpackPayload,
  type RunnerTurnInterruptPayload,
  type RunnerTurnSteerPayload,
  type RunnerTurnStartPayload,
  type ServerToClientMessage,
  type ServerToRunnerMessage,
  type TurnStartPayload,
} from "../../../packages/protocol/src/index.ts";
import {
  inspectHandoffPackage,
  validateHandoffManifest,
  type HandoffManifest,
} from "../../../packages/workspace-packager/src/index.ts";
import type { AuthenticatedSession } from "./auth.ts";
import { AuthError, AuthService } from "./auth.ts";
import type { CloudServerConfig } from "./config.ts";
import { CloudDatabase } from "./db.ts";
import { WebSocketConnection, authenticateWebSocketUpgrade, acceptWebSocket } from "./websocket.ts";

const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 512 * 1024;
const MOBILE_WEB_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../mobile-web/public",
);

export interface CloudServer {
  readonly server: ReturnType<typeof createServer>;
  readonly db: CloudDatabase;
  readonly auth: AuthService;
  readonly listen: () => Promise<{ readonly port: number; readonly url: string }>;
  readonly close: () => Promise<void>;
}

type DeviceKind = "runner" | "client" | "owner";

function nowIso(): string {
  return new Date().toISOString();
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function sendStatic(res: ServerResponse, filePath: string): void {
  const contentType =
    extname(filePath) === ".js"
      ? "text/javascript; charset=utf-8"
      : extname(filePath) === ".css"
        ? "text/css; charset=utf-8"
        : "text/html; charset=utf-8";
  const body = readFileSync(filePath);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": body.byteLength,
    "cache-control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=60",
  });
  res.end(body);
}

function sendBytes(res: ServerResponse, filePath: string): void {
  const body = readFileSync(filePath);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  if (!body.trim()) {
    return {};
  }
  return JSON.parse(body);
}

function parseDeviceKind(value: unknown, fallback?: DeviceKind): DeviceKind {
  if (value === "runner" || value === "client" || value === "owner") {
    return value;
  }
  if (fallback) return fallback;
  throw new AuthError("device_kind_invalid", "Invalid device kind.", 400);
}

function parseStringField(record: Record<string, unknown>, key: string, required = true): string {
  const value = record[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!required) return "";
  throw new AuthError("payload_invalid", `${key} is required.`, 400);
}

function parseOptionalInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AuthError("payload_invalid", `${key} must be an integer.`, 400);
  }
  return value;
}

function parseApprovalDecision(value: unknown): ApprovalDecision {
  if (value === "accept" || value === "decline" || value === "cancel") {
    return value;
  }
  throw new AuthError("approval_decision_invalid", "Invalid approval decision.", 400);
}

function parseCloudProjectId(value: unknown): string {
  const projectId = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(projectId)) {
    throw new AuthError(
      "project_id_invalid",
      "projectId must be 1-80 chars and contain only letters, numbers, dot, underscore, or dash.",
      400,
    );
  }
  if (projectId === "." || projectId === ".." || projectId.includes("..")) {
    throw new AuthError("project_id_invalid", "projectId may not contain path traversal.", 400);
  }
  return projectId;
}

function parseSha256(value: unknown, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new AuthError("sha256_invalid", "sha256 must be 64 lowercase hex chars.", 400);
  }
  return value;
}

function parseUploadPath(
  pathname: string,
): { readonly uploadId: string; readonly action: "chunks" | "complete" | "package" } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "api" || parts[1] !== "uploads") return null;
  if (parts[3] !== "chunks" && parts[3] !== "complete" && parts[3] !== "package") return null;
  return {
    uploadId: decodeURIComponent(parts[2]),
    action: parts[3],
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthError("payload_invalid", "Request body must be a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

function isMobileWebPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/app.js" ||
    pathname === "/styles.css"
  );
}

function resolveMobileWebPath(pathname: string): string | null {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = resolve(join(MOBILE_WEB_ROOT, relative));
  if (!filePath.startsWith(MOBILE_WEB_ROOT) || !existsSync(filePath)) {
    return null;
  }
  return statSync(filePath).isFile() ? filePath : null;
}

function parseThreadActionPath(
  pathname: string,
): { readonly cloudThreadId: string; readonly action: "steer" | "interrupt" } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "api" || parts[1] !== "threads") return null;
  if (parts[3] !== "steer" && parts[3] !== "interrupt") return null;
  return {
    cloudThreadId: decodeURIComponent(parts[2]),
    action: parts[3],
  };
}

function parseApprovalActionPath(
  pathname: string,
): { readonly approvalId: string; readonly action: "resolve" } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "api" || parts[1] !== "approvals") return null;
  if (parts[3] !== "resolve") return null;
  return {
    approvalId: decodeURIComponent(parts[2]),
    action: "resolve",
  };
}

function canUseEndpoint(session: AuthenticatedSession, endpoint: "runner" | "client"): boolean {
  if (session.deviceKind === "owner") return true;
  return session.deviceKind === endpoint;
}

function toSessionJson(session: AuthenticatedSession) {
  return {
    authenticated: true,
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    deviceKind: session.deviceKind,
    deviceName: session.deviceName,
    expiresAt: session.expiresAt,
  };
}

class WsConnectionRegistry {
  readonly clients = new Set<WebSocketConnection>();
  readonly runners = new Set<WebSocketConnection>();
  readonly runnerIds = new Map<WebSocketConnection, string>();
  readonly runnerConnections = new Map<string, WebSocketConnection>();

  broadcastToClients(message: ServerToClientMessage): void {
    const raw = JSON.stringify(message);
    for (const client of this.clients) {
      client.sendText(raw);
    }
  }

  sendToRunner(runnerId: string, message: ServerToRunnerMessage): boolean {
    const connection = this.runnerConnections.get(runnerId);
    if (!connection) {
      return false;
    }
    connection.sendJson(message);
    return true;
  }
}

function handleHttpRequest(input: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly auth: AuthService;
  readonly db: CloudDatabase;
  readonly registry: WsConnectionRegistry;
  readonly config: CloudServerConfig;
}) {
  const { req, res, auth, db, registry } = input;
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && isMobileWebPath(url.pathname)) {
        const filePath = resolveMobileWebPath(url.pathname);
        if (filePath) {
          sendStatic(res, filePath);
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/api/session") {
        const session = auth.authenticateRequest(req);
        sendJson(res, 200, toSessionJson(session));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/pairing-tokens") {
        const session = auth.authenticateBootstrapOrRequest(req);
        const body = toRecord(await readJsonBody(req));
        const created = auth.createPairingToken({
          deviceKind: parseDeviceKind(body.deviceKind),
          label: parseStringField(body, "label", false) || undefined,
          ttlSeconds: parseOptionalInteger(body, "ttlSeconds"),
          createdByDeviceId: session?.deviceId ?? null,
        });
        sendJson(res, 201, created);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/pairing/finish") {
        const body = toRecord(await readJsonBody(req));
        const result = auth.finishPairing({
          pairingToken: parseStringField(body, "pairingToken"),
          deviceName: parseStringField(body, "deviceName"),
          deviceKind:
            body.deviceKind === undefined ? undefined : parseDeviceKind(body.deviceKind),
        });
        auth.setSessionCookie(res, result.sessionToken, result.expiresAt);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        auth.authenticateRequest(req);
        const afterSequence = Number.parseInt(url.searchParams.get("afterSequence") ?? "0", 10);
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
        const events = db.listEvents({
          afterSequence: Number.isFinite(afterSequence) ? afterSequence : 0,
          limit: Number.isFinite(limit) ? limit : 100,
          runnerId: url.searchParams.get("runnerId") ?? undefined,
          threadId: url.searchParams.get("threadId") ?? undefined,
        });
        sendJson(res, 200, { events });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/runners") {
        auth.authenticateRequest(req);
        sendJson(res, 200, { runners: db.listRunners() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cloud-projects") {
        const session = auth.authenticateRequest(req);
        const body = toRecord(await readJsonBody(req));
        const result = createCloudProjectFromClient({
          db,
          registry,
          actorDeviceId: session.deviceId,
          runnerId: parseStringField(body, "runnerId"),
          projectId: parseCloudProjectId(body.projectId),
          name: parseStringField(body, "name", false) || undefined,
        });
        sendJson(res, 202, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/uploads/init") {
        const session = auth.authenticateRequest(req);
        const body = toRecord(await readJsonBody(req));
        const result = initUploadFromClient({
          config: input.config,
          db,
          actorDeviceId: session.deviceId,
          runnerId: parseStringField(body, "runnerId"),
          projectId: parseCloudProjectId(body.projectId),
          totalBytes: parseOptionalInteger(body, "totalBytes") ?? 0,
          expectedSha256: parseSha256(body.sha256, false),
          manifest: validateHandoffManifest(body.manifest),
        });
        sendJson(res, 201, result);
        return;
      }

      if (req.method === "POST" && url.pathname.startsWith("/api/uploads/")) {
        const session = auth.authenticateRequest(req);
        const action = parseUploadPath(url.pathname);
        if (action?.action === "chunks") {
          const body = toRecord(await readJsonBody(req));
          const result = appendUploadChunkFromClient({
            db,
            actorDeviceId: session.deviceId,
            uploadId: action.uploadId,
            index: parseOptionalInteger(body, "index") ?? 0,
            dataBase64: parseStringField(body, "dataBase64"),
            sha256: parseSha256(body.sha256),
          });
          sendJson(res, 202, result);
          return;
        }
        if (action?.action === "complete") {
          const body = toRecord(await readJsonBody(req));
          const result = completeUploadFromClient({
            db,
            registry,
            actorDeviceId: session.deviceId,
            uploadId: action.uploadId,
            sha256: parseSha256(body.sha256),
          });
          sendJson(res, 202, result);
          return;
        }
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/uploads/")) {
        auth.authenticateRequest(req);
        const action = parseUploadPath(url.pathname);
        if (action?.action === "package") {
          const upload = db.getUpload(action.uploadId);
          if (!upload || upload.status !== "complete") {
            throw new AuthError("upload_not_found", "Upload package is not available.", 404);
          }
          sendBytes(res, upload.filePath);
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/api/projects") {
        auth.authenticateRequest(req);
        sendJson(res, 200, {
          projects: db.listProjects({
            runnerId: url.searchParams.get("runnerId") ?? undefined,
          }),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/turns/start") {
        const session = auth.authenticateRequest(req);
        const body = toRecord(await readJsonBody(req));
        const result = startTurnFromClient({
          db,
          registry,
          actorDeviceId: session.deviceId,
          payload: parseTurnStartPayload(body),
        });
        sendJson(res, 202, result);
        return;
      }

      if (req.method === "POST" && url.pathname.startsWith("/api/threads/")) {
        const session = auth.authenticateRequest(req);
        const action = parseThreadActionPath(url.pathname);
        if (action?.action === "steer") {
          const body = toRecord(await readJsonBody(req));
          const result = steerThreadFromClient({
            db,
            registry,
            actorDeviceId: session.deviceId,
            cloudThreadId: action.cloudThreadId,
            prompt: parseStringField(body, "prompt"),
          });
          sendJson(res, 202, result);
          return;
        }
        if (action?.action === "interrupt") {
          const result = interruptThreadFromClient({
            db,
            registry,
            actorDeviceId: session.deviceId,
            cloudThreadId: action.cloudThreadId,
          });
          sendJson(res, 202, result);
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/api/threads") {
        auth.authenticateRequest(req);
        const threads = db.listThreads({
          runnerId: url.searchParams.get("runnerId") ?? undefined,
          projectId: url.searchParams.get("projectId") ?? undefined,
        });
        sendJson(res, 200, { threads });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/threads/")) {
        auth.authenticateRequest(req);
        const cloudThreadId = decodeURIComponent(url.pathname.slice("/api/threads/".length));
        sendJson(res, 200, { thread: db.getThread(cloudThreadId) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/approvals") {
        auth.authenticateRequest(req);
        const rawStatus = url.searchParams.get("status");
        sendJson(res, 200, {
          approvals: db.listApprovals({
            status: rawStatus === "pending" || rawStatus === "resolved" ? rawStatus : undefined,
            threadId: url.searchParams.get("threadId") ?? undefined,
          }),
        });
        return;
      }

      if (req.method === "POST" && url.pathname.startsWith("/api/approvals/")) {
        const session = auth.authenticateRequest(req);
        const action = parseApprovalActionPath(url.pathname);
        if (action?.action === "resolve") {
          const body = toRecord(await readJsonBody(req));
          const result = resolveApprovalFromClient({
            db,
            registry,
            actorDeviceId: session.deviceId,
            approvalId: action.approvalId,
            decision: parseApprovalDecision(body.decision),
          });
          sendJson(res, 202, result);
          return;
        }
      }

      sendError(res, 404, "not_found", "Not found.");
    } catch (error) {
      if (error instanceof AuthError) {
        sendError(res, error.status, error.code, error.message);
        return;
      }
      sendError(
        res,
        500,
        "internal_error",
        error instanceof Error ? error.message : "Internal server error.",
      );
    }
  })();
}

function handleRunnerMessage(input: {
  readonly db: CloudDatabase;
  readonly registry: WsConnectionRegistry;
  readonly connection: WebSocketConnection;
  readonly session: AuthenticatedSession;
  readonly raw: string;
}): void {
  const parsed = parseJson(RunnerToServerMessageSchema, input.raw);
  if (!parsed.ok) {
    input.connection.sendJson(
      createErrorEnvelope({
        code: "message_invalid",
        message: parsed.error,
      }),
    );
    return;
  }

  const message = parsed.value;
  switch (message.type) {
    case "ping":
      input.connection.sendJson(createEnvelope("pong", message.payload));
      return;
    case "runner.hello": {
      const previousRunnerId = input.registry.runnerIds.get(input.connection);
      if (previousRunnerId) {
        input.registry.runnerConnections.delete(previousRunnerId);
      }
      input.registry.runnerIds.set(input.connection, message.payload.runnerId);
      input.registry.runnerConnections.set(message.payload.runnerId, input.connection);
      input.db.upsertRunner({
        runnerId: message.payload.runnerId,
        deviceId: input.session.deviceId,
        name: message.payload.name,
        version: message.payload.version,
        capabilities: message.payload.capabilities,
        connected: true,
        lastSeenAt: nowIso(),
      });
      for (const project of message.payload.projects ?? []) {
        input.db.upsertProject({
          runnerId: message.payload.runnerId,
          projectId: project.projectId,
          name: project.name,
          lastSeenAt: nowIso(),
        });
      }
      input.db.appendAudit({
        actorKind: "device",
        actorDeviceId: input.session.deviceId,
        action: "runner.connected",
        targetKind: "runner",
        targetId: message.payload.runnerId,
        ok: true,
      });
      input.connection.sendJson(
        createEnvelope("runner.hello.ack", {
          runnerId: message.payload.runnerId,
          connectionId: input.connection.id,
        }),
      );
      return;
    }
    case "runner.project.created": {
      const runnerId = input.registry.runnerIds.get(input.connection);
      if (!runnerId) {
        input.connection.sendJson(
          createErrorEnvelope({
            code: "runner_not_registered",
            message: "Send runner.hello before creating projects.",
            requestId: message.id,
          }),
        );
        return;
      }
      input.db.upsertProject({
        runnerId,
        projectId: message.payload.projectId,
        name: message.payload.name,
        lastSeenAt: message.payload.createdAt,
      });
      input.db.appendAudit({
        actorKind: "device",
        actorDeviceId: input.session.deviceId,
        action: "cloud_project.created",
        targetKind: "project",
        targetId: message.payload.projectId,
        ok: true,
        detail: {
          runnerId,
          commandId: message.payload.commandId,
        },
      });
      return;
    }
    case "runner.workspace.unpacked": {
      const runnerId = input.registry.runnerIds.get(input.connection);
      if (!runnerId) {
        input.connection.sendJson(
          createErrorEnvelope({
            code: "runner_not_registered",
            message: "Send runner.hello before unpacking workspaces.",
            requestId: message.id,
          }),
        );
        return;
      }
      input.db.upsertProject({
        runnerId,
        projectId: message.payload.projectId,
        name: message.payload.name,
        lastSeenAt: message.payload.createdAt,
      });
      const upload = input.db.getUpload(message.payload.uploadId);
      if (upload?.handoffPrompt) {
        const result = startTurnFromClient({
          db: input.db,
          registry: input.registry,
          actorDeviceId: upload.actorDeviceId,
          payload: {
            runnerId,
            projectId: message.payload.projectId,
            prompt: upload.handoffPrompt,
          },
        });
        input.db.markUploadUnpacked({
          uploadId: message.payload.uploadId,
          cloudThreadId: result.cloudThreadId,
          unpackedAt: nowIso(),
        });
      }
      input.db.appendAudit({
        actorKind: "device",
        actorDeviceId: input.session.deviceId,
        action: "handoff.workspace.unpacked",
        targetKind: "upload",
        targetId: message.payload.uploadId,
        ok: true,
        detail: {
          runnerId,
          projectId: message.payload.projectId,
          commandId: message.payload.commandId,
        },
      });
      return;
    }
    case "runner.command.ack": {
      input.db.updateRunnerCommandStatus({
        commandId: message.payload.commandId,
        status: message.payload.accepted ? "accepted" : "rejected",
        updatedAt: nowIso(),
      });
      input.db.appendAudit({
        actorKind: "device",
        actorDeviceId: input.session.deviceId,
        action: "runner.command.ack",
        targetKind: "runner_command",
        targetId: message.payload.commandId,
        ok: message.payload.accepted,
        detail: {
          cloudThreadId: message.payload.cloudThreadId ?? null,
          message: message.payload.message ?? null,
        },
      });
      return;
    }
    case "runner.thread.status": {
      const thread = input.db.updateThreadStatus({
        cloudThreadId: message.payload.cloudThreadId,
        status: message.payload.status,
        providerThreadId: message.payload.providerThreadId,
        activeTurnId: message.payload.activeTurnId ?? null,
        lastEventSequence: message.payload.lastEventSequence,
        updatedAt: nowIso(),
      });
      if (thread) {
        input.registry.broadcastToClients(createEnvelope("thread.status.result", { thread }));
      }
      return;
    }
    case "runner.approval.opened": {
      const runnerId = input.registry.runnerIds.get(input.connection);
      if (!runnerId) {
        input.connection.sendJson(
          createErrorEnvelope({
            code: "runner_not_registered",
            message: "Send runner.hello before opening approvals.",
            requestId: message.id,
          }),
        );
        return;
      }
      const approval = input.db.upsertPendingApproval({
        approvalId: message.payload.approvalId,
        runnerId,
        cloudThreadId: message.payload.cloudThreadId,
        projectId: message.payload.projectId,
        approvalType: message.payload.approvalType,
        status: "pending",
        payload: message.payload.payload,
        createdAt: message.payload.createdAt,
      });
      input.registry.broadcastToClients(createEnvelope("approval.updated", { approval }));
      return;
    }
    case "runner.approval.resolved": {
      const approval = input.db.resolvePendingApproval({
        approvalId: message.payload.approvalId,
        status: "resolved",
        decision: message.payload.decision,
        resolvedAt: message.payload.resolvedAt,
      });
      if (approval) {
        input.registry.broadcastToClients(createEnvelope("approval.updated", { approval }));
      }
      return;
    }
    case "runner.event.append": {
      const runnerId = input.registry.runnerIds.get(input.connection);
      if (!runnerId) {
        input.connection.sendJson(
          createErrorEnvelope({
            code: "runner_not_registered",
            message: "Send runner.hello before appending events.",
            requestId: message.id,
          }),
        );
        return;
      }
      try {
        const event = input.db.appendEvent({
          eventId: message.payload.eventId,
          runnerId,
          projectId: message.payload.projectId,
          threadId: message.payload.threadId,
          type: message.payload.type,
          payload: message.payload.payload,
          occurredAt: message.payload.occurredAt,
          receivedAt: nowIso(),
        });
        input.db.updateThreadLastEvent({
          cloudThreadId: event.threadId,
          sequence: event.sequence,
          updatedAt: event.receivedAt,
        });
        input.db.appendAudit({
          actorKind: "device",
          actorDeviceId: input.session.deviceId,
          action: "event.appended",
          targetKind: "event",
          targetId: event.eventId,
          ok: true,
          detail: {
            sequence: event.sequence,
            runnerId,
            threadId: event.threadId,
            type: event.type,
          },
        });
        input.connection.sendJson(
          createEnvelope("runner.event.ack", {
            eventId: event.eventId,
            sequence: event.sequence,
          }),
        );
        input.registry.broadcastToClients(createEnvelope("event.appended", { event }));
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const existing = input.db.getEventById(message.payload.eventId);
          if (existing) {
            input.connection.sendJson(
              createEnvelope("runner.event.ack", {
                eventId: existing.eventId,
                sequence: existing.sequence,
              }),
            );
            return;
          }
        }
        input.connection.sendJson(
          createErrorEnvelope({
            code: "event_append_failed",
            message: error instanceof Error ? error.message : "Failed to append event.",
            requestId: message.id,
          }),
        );
      }
      return;
    }
  }
}

function handleClientMessage(input: {
  readonly db: CloudDatabase;
  readonly registry: WsConnectionRegistry;
  readonly session: AuthenticatedSession;
  readonly connection: WebSocketConnection;
  readonly raw: string;
}): void {
  const parsed = parseJson(ClientToServerMessageSchema, input.raw);
  if (!parsed.ok) {
    input.connection.sendJson(
      createErrorEnvelope({
        code: "message_invalid",
        message: parsed.error,
      }),
    );
    return;
  }

  const message = parsed.value;
  switch (message.type) {
    case "ping":
      input.connection.sendJson(createEnvelope("pong", message.payload));
      return;
    case "client.hello":
      input.connection.sendJson(
        createEnvelope("client.hello.ack", {
          connectionId: input.connection.id,
        }),
      );
      return;
    case "events.list": {
      const events = input.db.listEvents(message.payload);
      input.connection.sendJson(createEnvelope("events.list.result", { events }));
      return;
    }
    case "turn.start": {
      try {
        const result = startTurnFromClient({
          db: input.db,
          registry: input.registry,
          actorDeviceId: input.session.deviceId,
          payload: message.payload,
        });
        input.connection.sendJson(createEnvelope("turn.start.accepted", result));
      } catch (error) {
        input.connection.sendJson(
          createErrorEnvelope({
            code: error instanceof AuthError ? error.code : "turn_start_failed",
            message: error instanceof Error ? error.message : "Failed to start turn.",
            requestId: message.id,
          }),
        );
      }
      return;
    }
    case "threads.list": {
      const threads = input.db.listThreads(message.payload);
      input.connection.sendJson(createEnvelope("threads.list.result", { threads }));
      return;
    }
    case "thread.status": {
      const thread = input.db.getThread(message.payload.cloudThreadId);
      input.connection.sendJson(createEnvelope("thread.status.result", { thread }));
      return;
    }
  }
}

function parseTurnStartPayload(record: Record<string, unknown>): TurnStartPayload {
  return {
    runnerId: parseStringField(record, "runnerId"),
    projectId: parseStringField(record, "projectId"),
    prompt: parseStringField(record, "prompt"),
    ...(typeof record.cloudThreadId === "string" && record.cloudThreadId.trim()
      ? { cloudThreadId: record.cloudThreadId.trim() }
      : {}),
  };
}

function startTurnFromClient(input: {
  readonly db: CloudDatabase;
  readonly registry: WsConnectionRegistry;
  readonly actorDeviceId: string;
  readonly payload: TurnStartPayload;
}): {
  readonly commandId: string;
  readonly cloudThreadId: string;
  readonly runnerId: string;
  readonly projectId: string;
  readonly status: "queued";
} {
  if (!input.registry.runnerConnections.has(input.payload.runnerId)) {
    throw new AuthError("runner_unavailable", "Runner is not connected.", 409);
  }
  const now = nowIso();
  const cloudThreadId = input.payload.cloudThreadId ?? `thread_${randomUUID()}`;
  const commandId = `cmd_${randomUUID()}`;
  const thread = input.db.createThread({
    cloudThreadId,
    runnerId: input.payload.runnerId,
    projectId: input.payload.projectId,
    status: "queued",
    createdAt: now,
  });
  const commandPayload: RunnerTurnStartPayload = {
    commandId,
    cloudThreadId,
    projectId: input.payload.projectId,
    prompt: input.payload.prompt,
    requestedAt: now,
  };
  input.db.createRunnerCommand({
    commandId,
    runnerId: input.payload.runnerId,
    cloudThreadId,
    commandType: "turn.start",
    status: "sent",
    payload: {
      projectId: input.payload.projectId,
      promptLength: input.payload.prompt.length,
    },
    createdAt: now,
  });
  input.db.appendAudit({
    actorKind: "device",
    actorDeviceId: input.actorDeviceId,
    action: "turn.start.forwarded",
    targetKind: "thread",
    targetId: cloudThreadId,
    ok: true,
    detail: {
      runnerId: input.payload.runnerId,
      projectId: input.payload.projectId,
      commandId,
      promptLength: input.payload.prompt.length,
    },
  });
  const sent = input.registry.sendToRunner(
    input.payload.runnerId,
    createEnvelope("runner.turn.start", commandPayload),
  );
  if (!sent) {
    input.db.updateThreadStatus({
      cloudThreadId,
      status: "error",
      updatedAt: nowIso(),
    });
    throw new AuthError("runner_unavailable", "Runner disconnected before command dispatch.", 409);
  }
  return {
    commandId,
    cloudThreadId: thread.cloudThreadId,
    runnerId: thread.runnerId,
    projectId: thread.projectId,
    status: "queued",
  };
}

function initUploadFromClient(input: {
  readonly config: CloudServerConfig;
  readonly db: CloudDatabase;
  readonly actorDeviceId: string;
  readonly runnerId: string;
  readonly projectId: string;
  readonly totalBytes: number;
  readonly expectedSha256?: string;
  readonly manifest: HandoffManifest;
}): {
  readonly uploadId: string;
  readonly chunkSize: number;
  readonly status: "initialized";
} {
  if (input.totalBytes <= 0 || input.totalBytes > 100 * 1024 * 1024) {
    throw new AuthError("upload_size_invalid", "Upload size must be between 1 byte and 100 MiB.", 400);
  }
  if (input.manifest.bundle.bytes <= 0) {
    throw new AuthError("bundle_invalid", "Handoff bundle is empty.", 400);
  }
  const uploadId = `upload_${randomUUID()}`;
  mkdirSync(input.config.uploadDir, { recursive: true, mode: 0o700 });
  const filePath = resolve(input.config.uploadDir, `${uploadId}.json`);
  writeFileSync(filePath, "", { mode: 0o600 });
  input.db.createUpload({
    uploadId,
    runnerId: input.runnerId,
    projectId: input.projectId,
    actorDeviceId: input.actorDeviceId,
    status: "initialized",
    filePath,
    totalBytes: input.totalBytes,
    expectedSha256: input.expectedSha256,
    manifest: input.manifest,
    createdAt: nowIso(),
  });
  input.db.appendAudit({
    actorKind: "device",
    actorDeviceId: input.actorDeviceId,
    action: "handoff.upload.initialized",
    targetKind: "upload",
    targetId: uploadId,
    ok: true,
    detail: {
      runnerId: input.runnerId,
      projectId: input.projectId,
      totalBytes: input.totalBytes,
    },
  });
  return { uploadId, chunkSize: UPLOAD_CHUNK_BYTES, status: "initialized" };
}

function appendUploadChunkFromClient(input: {
  readonly db: CloudDatabase;
  readonly actorDeviceId: string;
  readonly uploadId: string;
  readonly index: number;
  readonly dataBase64: string;
  readonly sha256: string;
}): {
  readonly uploadId: string;
  readonly receivedBytes: number;
  readonly status: "chunk_received";
} {
  const upload = input.db.getUpload(input.uploadId);
  if (!upload || upload.status !== "initialized") {
    throw new AuthError("upload_not_found", "Upload is not available for chunks.", 404);
  }
  if (upload.actorDeviceId !== input.actorDeviceId) {
    throw new AuthError("upload_forbidden", "Upload belongs to another device.", 403);
  }
  const expectedIndex = Math.floor(upload.receivedBytes / UPLOAD_CHUNK_BYTES);
  if (input.index !== expectedIndex) {
    throw new AuthError("upload_chunk_order_invalid", "Upload chunks must be sent sequentially.", 409);
  }
  const chunk = Buffer.from(input.dataBase64, "base64");
  if (chunk.byteLength <= 0 || chunk.byteLength > UPLOAD_CHUNK_BYTES) {
    throw new AuthError("upload_chunk_size_invalid", "Invalid upload chunk size.", 400);
  }
  if (sha256(chunk) !== input.sha256) {
    throw new AuthError("upload_chunk_hash_invalid", "Upload chunk sha256 mismatch.", 400);
  }
  if (upload.receivedBytes + chunk.byteLength > upload.totalBytes) {
    throw new AuthError("upload_too_large", "Upload exceeds declared total size.", 413);
  }
  appendFileSync(upload.filePath, chunk);
  const updated = input.db.addUploadBytes({
    uploadId: input.uploadId,
    bytes: chunk.byteLength,
  });
  return {
    uploadId: input.uploadId,
    receivedBytes: updated?.receivedBytes ?? upload.receivedBytes + chunk.byteLength,
    status: "chunk_received",
  };
}

function completeUploadFromClient(input: {
  readonly db: CloudDatabase;
  readonly registry: WsConnectionRegistry;
  readonly actorDeviceId: string;
  readonly uploadId: string;
  readonly sha256: string;
}): {
  readonly uploadId: string;
  readonly commandId: string;
  readonly status: "unpack_sent";
} {
  const upload = input.db.getUpload(input.uploadId);
  if (!upload || upload.status !== "initialized") {
    throw new AuthError("upload_not_found", "Upload is not available for completion.", 404);
  }
  if (upload.actorDeviceId !== input.actorDeviceId) {
    throw new AuthError("upload_forbidden", "Upload belongs to another device.", 403);
  }
  if (upload.receivedBytes !== upload.totalBytes) {
    throw new AuthError("upload_incomplete", "Upload has not received all bytes.", 409);
  }
  const raw = readFileSync(upload.filePath, "utf8");
  if (sha256(Buffer.from(raw)) !== input.sha256) {
    throw new AuthError("upload_hash_invalid", "Upload sha256 mismatch.", 400);
  }
  if (upload.expectedSha256 && upload.expectedSha256 !== input.sha256) {
    throw new AuthError("upload_hash_invalid", "Upload sha256 does not match initialization.", 400);
  }
  let inspected: ReturnType<typeof inspectHandoffPackage>;
  try {
    inspected = inspectHandoffPackage(raw);
  } catch (error) {
    throw new AuthError(
      "handoff_package_invalid",
      error instanceof Error ? error.message : "Invalid handoff package.",
      400,
    );
  }
  const commandId = `cmd_${randomUUID()}`;
  const payload: RunnerWorkspaceUnpackPayload = {
    commandId,
    uploadId: input.uploadId,
    projectId: upload.projectId,
    requestedAt: nowIso(),
  };
  if (!input.registry.sendToRunner(upload.runnerId, createEnvelope("runner.workspace.unpack", payload))) {
    throw new AuthError("runner_unavailable", "Runner is not connected.", 409);
  }
  input.db.markUploadCompleted({
    uploadId: input.uploadId,
    actualSha256: input.sha256,
    handoffPrompt: inspected.handoffPackage.handoffPrompt,
    commandId,
    completedAt: nowIso(),
  });
  input.db.appendAudit({
    actorKind: "device",
    actorDeviceId: input.actorDeviceId,
    action: "handoff.upload.completed",
    targetKind: "upload",
    targetId: input.uploadId,
    ok: true,
    detail: {
      runnerId: upload.runnerId,
      projectId: upload.projectId,
      commandId,
    },
  });
  return { uploadId: input.uploadId, commandId, status: "unpack_sent" };
}

function createCloudProjectFromClient(input: {
  readonly db: CloudDatabase;
  readonly registry: WsConnectionRegistry;
  readonly actorDeviceId: string;
  readonly runnerId: string;
  readonly projectId: string;
  readonly name?: string;
}): {
  readonly commandId: string;
  readonly runnerId: string;
  readonly projectId: string;
  readonly status: "sent";
} {
  if (!input.registry.runnerConnections.has(input.runnerId)) {
    throw new AuthError("runner_unavailable", "Runner is not connected.", 409);
  }
  const now = nowIso();
  const commandId = `cmd_${randomUUID()}`;
  const payload: RunnerProjectCreatePayload = {
    commandId,
    projectId: input.projectId,
    ...(input.name ? { name: input.name } : {}),
    requestedAt: now,
  };
  input.db.appendAudit({
    actorKind: "device",
    actorDeviceId: input.actorDeviceId,
    action: "cloud_project.create.forwarded",
    targetKind: "project",
    targetId: input.projectId,
    ok: true,
    detail: {
      runnerId: input.runnerId,
      commandId,
    },
  });
  if (!input.registry.sendToRunner(input.runnerId, createEnvelope("runner.project.create", payload))) {
    throw new AuthError("runner_unavailable", "Runner disconnected before command dispatch.", 409);
  }
  return {
    commandId,
    runnerId: input.runnerId,
    projectId: input.projectId,
    status: "sent",
  };
}

function steerThreadFromClient(input: {
  readonly db: CloudDatabase;
  readonly registry: WsConnectionRegistry;
  readonly actorDeviceId: string;
  readonly cloudThreadId: string;
  readonly prompt: string;
}): { readonly commandId: string; readonly cloudThreadId: string; readonly status: "sent" } {
  const thread = input.db.getThread(input.cloudThreadId);
  if (!thread) {
    throw new AuthError("thread_not_found", "Thread not found.", 404);
  }
  const now = nowIso();
  const commandId = `cmd_${randomUUID()}`;
  const payload: RunnerTurnSteerPayload = {
    commandId,
    cloudThreadId: input.cloudThreadId,
    prompt: input.prompt,
    requestedAt: now,
  };
  input.db.createRunnerCommand({
    commandId,
    runnerId: thread.runnerId,
    cloudThreadId: input.cloudThreadId,
    commandType: "turn.steer",
    status: "sent",
    payload: { promptLength: input.prompt.length },
    createdAt: now,
  });
  input.db.appendAudit({
    actorKind: "device",
    actorDeviceId: input.actorDeviceId,
    action: "turn.steer.forwarded",
    targetKind: "thread",
    targetId: input.cloudThreadId,
    ok: true,
    detail: {
      runnerId: thread.runnerId,
      commandId,
      promptLength: input.prompt.length,
    },
  });
  if (!input.registry.sendToRunner(thread.runnerId, createEnvelope("runner.turn.steer", payload))) {
    throw new AuthError("runner_unavailable", "Runner is not connected.", 409);
  }
  return { commandId, cloudThreadId: input.cloudThreadId, status: "sent" };
}

function interruptThreadFromClient(input: {
  readonly db: CloudDatabase;
  readonly registry: WsConnectionRegistry;
  readonly actorDeviceId: string;
  readonly cloudThreadId: string;
}): { readonly commandId: string; readonly cloudThreadId: string; readonly status: "sent" } {
  const thread = input.db.getThread(input.cloudThreadId);
  if (!thread) {
    throw new AuthError("thread_not_found", "Thread not found.", 404);
  }
  const now = nowIso();
  const commandId = `cmd_${randomUUID()}`;
  const payload: RunnerTurnInterruptPayload = {
    commandId,
    cloudThreadId: input.cloudThreadId,
    requestedAt: now,
  };
  input.db.createRunnerCommand({
    commandId,
    runnerId: thread.runnerId,
    cloudThreadId: input.cloudThreadId,
    commandType: "turn.interrupt",
    status: "sent",
    payload: {},
    createdAt: now,
  });
  input.db.appendAudit({
    actorKind: "device",
    actorDeviceId: input.actorDeviceId,
    action: "turn.interrupt.forwarded",
    targetKind: "thread",
    targetId: input.cloudThreadId,
    ok: true,
    detail: { runnerId: thread.runnerId, commandId },
  });
  if (!input.registry.sendToRunner(thread.runnerId, createEnvelope("runner.turn.interrupt", payload))) {
    throw new AuthError("runner_unavailable", "Runner is not connected.", 409);
  }
  return { commandId, cloudThreadId: input.cloudThreadId, status: "sent" };
}

function resolveApprovalFromClient(input: {
  readonly db: CloudDatabase;
  readonly registry: WsConnectionRegistry;
  readonly actorDeviceId: string;
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
}): { readonly commandId: string; readonly approval: PendingApprovalSummary } {
  const approval = input.db.getApproval(input.approvalId);
  if (!approval) {
    throw new AuthError("approval_not_found", "Approval not found.", 404);
  }
  if (approval.status !== "pending") {
    throw new AuthError("approval_stale", "Approval is no longer pending.", 409);
  }
  const now = nowIso();
  const commandId = `cmd_${randomUUID()}`;
  const payload: RunnerApprovalResolvePayload = {
    commandId,
    approvalId: input.approvalId,
    cloudThreadId: approval.cloudThreadId,
    decision: input.decision,
    requestedAt: now,
  };
  input.db.createRunnerCommand({
    commandId,
    runnerId: approval.runnerId,
    cloudThreadId: approval.cloudThreadId,
    commandType: "approval.resolve",
    status: "sent",
    payload: { approvalId: input.approvalId, decision: input.decision },
    createdAt: now,
  });
  input.db.appendAudit({
    actorKind: "device",
    actorDeviceId: input.actorDeviceId,
    action: "approval.resolve.forwarded",
    targetKind: "approval",
    targetId: input.approvalId,
    ok: true,
    detail: {
      runnerId: approval.runnerId,
      cloudThreadId: approval.cloudThreadId,
      commandId,
      decision: input.decision,
    },
  });
  if (
    !input.registry.sendToRunner(
      approval.runnerId,
      createEnvelope("runner.approval.resolve", payload),
    )
  ) {
    throw new AuthError("runner_unavailable", "Runner is not connected.", 409);
  }
  return { commandId, approval };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("UNIQUE constraint failed") ||
      error.message.includes("constraint failed"))
  );
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function createCloudServer(config: CloudServerConfig): CloudServer {
  const db = new CloudDatabase(config.dbPath);
  const auth = new AuthService({ db, config });
  const registry = new WsConnectionRegistry();
  const server = createServer((req, res) =>
    handleHttpRequest({ req, res, auth, db, registry, config }),
  );
  const sockets = new Set<Socket>();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const endpoint =
      url.pathname === "/ws/runner" ? "runner" : url.pathname === "/ws/client" ? "client" : null;
    if (!endpoint) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const upgrade = authenticateWebSocketUpgrade({
      req,
      socket,
      auth,
      config,
      db,
    });
    if (!upgrade.ok) return;
    if (!canUseEndpoint(upgrade.session, endpoint)) {
      db.appendAudit({
        actorKind: "device",
        actorDeviceId: upgrade.session.deviceId,
        action: "ws.auth.failed",
        targetKind: "websocket",
        targetId: endpoint,
        ok: false,
        detail: { reason: "wrong_device_kind" },
      });
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const connection = acceptWebSocket({
      req,
      socket,
      maxPayloadBytes: config.maxWebSocketPayloadBytes,
    });
    if (endpoint === "client") {
      registry.clients.add(connection);
    } else {
      registry.runners.add(connection);
    }
    db.appendAudit({
      actorKind: "device",
      actorDeviceId: upgrade.session.deviceId,
      action: "ws.connected",
      targetKind: "websocket",
      targetId: endpoint,
      ok: true,
    });

    connection.onText = (raw) => {
      if (endpoint === "runner") {
        handleRunnerMessage({ db, registry, connection, session: upgrade.session, raw });
        return;
      }
      handleClientMessage({ db, registry, session: upgrade.session, connection, raw });
    };
    connection.onClose = () => {
      registry.clients.delete(connection);
      registry.runners.delete(connection);
      const runnerId = registry.runnerIds.get(connection);
      if (runnerId) {
        registry.runnerIds.delete(connection);
        registry.runnerConnections.delete(runnerId);
        db.markRunnerDisconnected({ runnerId, lastSeenAt: nowIso() });
      }
      db.appendAudit({
        actorKind: "device",
        actorDeviceId: upgrade.session.deviceId,
        action: "ws.disconnected",
        targetKind: "websocket",
        targetId: endpoint,
        ok: true,
      });
    };
  });

  return {
    server,
    db,
    auth,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Server did not bind to a TCP address."));
            return;
          }
          resolve({
            port: address.port,
            url: `http://${config.host}:${address.port}`,
          });
        });
      }),
    close: async () => {
      const pendingSockets = Array.from(sockets);
      const socketsClosed = Promise.all(
        pendingSockets.map(
          (socket) =>
            new Promise<void>((resolve) => {
              socket.once("close", () => resolve());
              socket.destroy();
            }),
        ),
      );
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await socketsClosed;
      await serverClosed;
      db.close();
    },
  };
}
