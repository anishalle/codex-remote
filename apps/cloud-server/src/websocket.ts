import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { AuthenticatedSession } from "./auth.ts";
import { AuthError, AuthService } from "./auth.ts";
import type { CloudServerConfig } from "./config.ts";
import type { CloudDatabase } from "./db.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TOKEN_QUERY_PARAMS = new Set(["access_token", "auth", "session", "token"]);

export interface AuthenticatedWebSocketUpgrade {
  readonly ok: true;
  readonly session: AuthenticatedSession;
}

export interface RejectedWebSocketUpgrade {
  readonly ok: false;
}

export type WebSocketUpgradeResult = AuthenticatedWebSocketUpgrade | RejectedWebSocketUpgrade;

export interface WebSocketConnectionOptions {
  readonly req: IncomingMessage;
  readonly socket: Duplex;
  readonly maxPayloadBytes: number;
}

export class WebSocketConnection {
  readonly id = randomUUID();
  readonly socket: Duplex;
  readonly maxPayloadBytes: number;
  onText?: (raw: string) => void;
  onClose?: () => void;

  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(input: WebSocketConnectionOptions) {
    this.socket = input.socket;
    this.maxPayloadBytes = input.maxPayloadBytes;
    this.socket.on("data", (chunk: Buffer) => this.receive(chunk));
    this.socket.on("close", () => this.finishClose());
    this.socket.on("error", () => this.finishClose());
  }

  sendJson(value: unknown): void {
    this.sendText(JSON.stringify(value));
  }

  sendText(raw: string): void {
    this.sendFrame(0x1, Buffer.from(raw, "utf8"));
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(reason, "utf8");
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.sendFrame(0x8, payload);
    this.socket.end();
    this.finishClose();
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const frame = this.readFrame();
      if (!frame) return;
      if (frame.payload.length > this.maxPayloadBytes) {
        this.close(1009, "payload too large");
        return;
      }
      switch (frame.opcode) {
        case 0x1:
          this.onText?.(frame.payload.toString("utf8"));
          break;
        case 0x8:
          this.close();
          return;
        case 0x9:
          this.sendFrame(0xA, frame.payload);
          break;
        case 0xA:
          break;
        default:
          this.close(1003, "unsupported frame");
          return;
      }
    }
  }

  private readFrame(): { readonly opcode: number; readonly payload: Buffer } | null {
    if (this.buffer.length < 2) return null;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0F;
    const masked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7F;
    let offset = 2;

    if (!fin) {
      this.close(1003, "fragmented messages are unsupported");
      return null;
    }
    if (!masked) {
      this.close(1002, "client frames must be masked");
      return null;
    }
    if (payloadLength === 126) {
      if (this.buffer.length < offset + 2) return null;
      payloadLength = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (this.buffer.length < offset + 8) return null;
      const length64 = this.buffer.readBigUInt64BE(offset);
      if (length64 > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.close(1009, "payload too large");
        return null;
      }
      payloadLength = Number(length64);
      offset += 8;
    }

    if (payloadLength > this.maxPayloadBytes) {
      this.close(1009, "payload too large");
      return null;
    }
    if (this.buffer.length < offset + 4 + payloadLength) return null;

    const mask = this.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
    this.buffer = this.buffer.subarray(offset + payloadLength);
    return { opcode, payload };
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.closed || !this.socket.writable) return;
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length <= 0xFFFF) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  private finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }
}

export function authenticateWebSocketUpgrade(input: {
  readonly req: IncomingMessage;
  readonly socket: Duplex;
  readonly auth: AuthService;
  readonly config: CloudServerConfig;
  readonly db: CloudDatabase;
}): WebSocketUpgradeResult {
  const { req, socket, auth, config, db } = input;
  const url = new URL(req.url ?? "/", "http://localhost");
  for (const param of TOKEN_QUERY_PARAMS) {
    if (url.searchParams.has(param)) {
      db.appendAudit({
        actorKind: "anonymous",
        action: "ws.auth.failed",
        targetKind: "websocket",
        targetId: url.pathname,
        ok: false,
        detail: { reason: "token_in_query", param },
      });
      rejectUpgrade(socket, 400, "Bad Request");
      return { ok: false };
    }
  }

  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (config.allowedOrigins.length > 0 && (!origin || !config.allowedOrigins.includes(origin))) {
    db.appendAudit({
      actorKind: "anonymous",
      action: "ws.auth.failed",
      targetKind: "websocket",
      targetId: url.pathname,
      ok: false,
      detail: { reason: "origin_denied", origin: origin ?? null },
    });
    rejectUpgrade(socket, 403, "Forbidden");
    return { ok: false };
  }

  try {
    return {
      ok: true,
      session: auth.authenticateRequest(req),
    };
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 401;
    const code = error instanceof AuthError ? error.code : "auth_failed";
    db.appendAudit({
      actorKind: "anonymous",
      action: "ws.auth.failed",
      targetKind: "websocket",
      targetId: url.pathname,
      ok: false,
      detail: { reason: code },
    });
    rejectUpgrade(socket, status, status === 403 ? "Forbidden" : "Unauthorized");
    return { ok: false };
  }
}

export function acceptWebSocket(input: WebSocketConnectionOptions): WebSocketConnection {
  const key = input.req.headers["sec-websocket-key"];
  if (typeof key !== "string" || key.trim().length === 0) {
    input.socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    input.socket.destroy();
    return new WebSocketConnection(input);
  }

  const acceptKey = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  input.socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "\r\n",
    ].join("\r\n"),
  );

  return new WebSocketConnection(input);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}
