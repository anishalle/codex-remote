import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import {
  ClientToServerMessageSchema,
  RunnerToServerMessageSchema,
  createEnvelope,
  createErrorEnvelope,
  parseJson,
  type CloudEvent,
  type ServerToClientMessage,
} from "../../../packages/protocol/src/index.ts";
import type { AuthenticatedSession } from "./auth.ts";
import { AuthError, AuthService } from "./auth.ts";
import type { CloudServerConfig } from "./config.ts";
import { CloudDatabase } from "./db.ts";
import { WebSocketConnection, authenticateWebSocketUpgrade, acceptWebSocket } from "./websocket.ts";

const MAX_HTTP_BODY_BYTES = 1024 * 1024;

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

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthError("payload_invalid", "Request body must be a JSON object.", 400);
  }
  return value as Record<string, unknown>;
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

  broadcastToClients(message: ServerToClientMessage): void {
    const raw = JSON.stringify(message);
    for (const client of this.clients) {
      client.sendText(raw);
    }
  }
}

function handleHttpRequest(input: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly auth: AuthService;
  readonly db: CloudDatabase;
}) {
  const { req, res, auth, db } = input;
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
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
      input.registry.runnerIds.set(input.connection, message.payload.runnerId);
      input.db.upsertRunner({
        runnerId: message.payload.runnerId,
        deviceId: input.session.deviceId,
        name: message.payload.name,
        version: message.payload.version,
        capabilities: message.payload.capabilities,
        connected: true,
        lastSeenAt: nowIso(),
      });
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
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("UNIQUE constraint failed") ||
      error.message.includes("constraint failed"))
  );
}

export function createCloudServer(config: CloudServerConfig): CloudServer {
  const db = new CloudDatabase(config.dbPath);
  const auth = new AuthService({ db, config });
  const registry = new WsConnectionRegistry();
  const server = createServer((req, res) => handleHttpRequest({ req, res, auth, db }));
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
      handleClientMessage({ db, connection, raw });
    };
    connection.onClose = () => {
      registry.clients.delete(connection);
      registry.runners.delete(connection);
      const runnerId = registry.runnerIds.get(connection);
      if (runnerId) {
        registry.runnerIds.delete(connection);
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
