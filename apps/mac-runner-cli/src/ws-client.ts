import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface OutboundWebSocketOptions {
  readonly url: string;
  readonly authorizationToken: string;
  readonly origin?: string;
  readonly handshakeTimeoutMs?: number;
}

export interface OutboundWebSocket {
  readonly sendJson: (value: unknown) => void;
  readonly close: () => void;
  onText?: (raw: string) => void;
  onClose?: () => void;
}

class RawOutboundWebSocket implements OutboundWebSocket {
  readonly socket: net.Socket | tls.TLSSocket;
  onText?: (raw: string) => void;
  onClose?: () => void;

  private buffer: Buffer;
  private closed = false;

  constructor(socket: net.Socket | tls.TLSSocket, initialBuffer = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = initialBuffer;
    this.socket.on("data", (chunk: Buffer) => this.receive(chunk));
    this.socket.on("close", () => this.finishClose());
    this.socket.on("error", () => this.finishClose());
    this.receive(Buffer.alloc(0));
  }

  sendJson(value: unknown): void {
    this.sendText(JSON.stringify(value));
  }

  close(): void {
    if (this.closed) return;
    this.sendFrame(0x8, Buffer.alloc(0));
    this.socket.end();
    this.finishClose();
  }

  private sendText(raw: string): void {
    this.sendFrame(0x1, Buffer.from(raw, "utf8"));
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    if (chunk.length > 0) {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
    while (true) {
      const decoded = decodeFrame(this.buffer);
      if (!decoded.frame) {
        this.buffer = decoded.rest;
        return;
      }
      this.buffer = decoded.rest;
      switch (decoded.frame.opcode) {
        case 0x1:
          this.onText?.(decoded.frame.payload.toString("utf8"));
          break;
        case 0x8:
          this.close();
          return;
        case 0x9:
          this.sendFrame(0xA, decoded.frame.payload);
          break;
        case 0xA:
          break;
        default:
          this.close();
          return;
      }
    }
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.closed || !this.socket.writable) return;
    const mask = randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length <= 0xFFFF) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.from(payload);
    for (let index = 0; index < masked.length; index += 1) {
      masked[index] ^= mask[index % 4];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  private finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }
}

export async function connectOutboundWebSocket(
  options: OutboundWebSocketOptions,
): Promise<OutboundWebSocket> {
  const url = new URL(options.url);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("WebSocket URL must use ws:// or wss://.");
  }
  if (hasTokenQuery(url)) {
    throw new Error("Refusing to connect with an auth token in the WebSocket query string.");
  }

  const socket = await openSocket(url);
  const key = randomBytes(16).toString("base64");
  const requestPath = `${url.pathname || "/"}${url.search}`;
  const headers = [
    `GET ${requestPath} HTTP/1.1`,
    `Host: ${url.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    `Authorization: Bearer ${options.authorizationToken}`,
  ];
  if (options.origin) {
    headers.push(`Origin: ${options.origin}`);
  }
  socket.write(`${headers.join("\r\n")}\r\n\r\n`);

  const response = await readUpgradeResponse(socket, options.handshakeTimeoutMs ?? 5000);
  if (response.statusCode !== 101) {
    socket.destroy();
    throw new Error(`WebSocket upgrade failed with HTTP ${response.statusCode}.`);
  }
  const acceptHeader = response.headers.get("sec-websocket-accept");
  const expectedAccept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  if (acceptHeader !== expectedAccept) {
    socket.destroy();
    throw new Error("WebSocket upgrade returned an invalid accept key.");
  }
  return new RawOutboundWebSocket(socket, response.rest);
}

function hasTokenQuery(url: URL): boolean {
  for (const key of ["access_token", "auth", "session", "token"]) {
    if (url.searchParams.has(key)) return true;
  }
  return false;
}

function openSocket(url: URL): Promise<net.Socket | tls.TLSSocket> {
  const port = Number.parseInt(url.port || (url.protocol === "wss:" ? "443" : "80"), 10);
  return new Promise((resolve, reject) => {
    const socket =
      url.protocol === "wss:"
        ? tls.connect({
            host: url.hostname,
            port,
            servername: url.hostname,
          })
        : net.connect({
            host: url.hostname,
            port,
          });
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("secureConnect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    if (url.protocol === "wss:") {
      socket.once("secureConnect", onConnect);
    } else {
      socket.once("connect", onConnect);
    }
    socket.once("error", onError);
  });
}

async function readUpgradeResponse(
  socket: net.Socket | tls.TLSSocket,
  timeoutMs: number,
): Promise<{
  readonly statusCode: number;
  readonly headers: Map<string, string>;
  readonly rest: Buffer;
}> {
  let buffer = Buffer.alloc(0);
  while (true) {
    const chunk = await waitForSocketData(socket, timeoutMs);
    buffer = Buffer.concat([buffer, chunk]);
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const rawHeader = buffer.subarray(0, headerEnd).toString("utf8");
    const lines = rawHeader.split("\r\n");
    const statusCode = Number.parseInt(lines[0]?.split(" ")[1] ?? "0", 10);
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const separator = line.indexOf(":");
      if (separator === -1) continue;
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
    return {
      statusCode,
      headers,
      rest: buffer.subarray(headerEnd + 4),
    };
  }
}

function waitForSocketData(
  socket: net.Socket | tls.TLSSocket,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket data."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("Socket ended before WebSocket upgrade completed."));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

function decodeFrame(buffer: Buffer): {
  readonly frame: { readonly opcode: number; readonly payload: Buffer } | null;
  readonly rest: Buffer;
} {
  if (buffer.length < 2) return { frame: null, rest: buffer };
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0F;
  const masked = (second & 0x80) !== 0;
  let payloadLength = second & 0x7F;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return { frame: null, rest: buffer };
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return { frame: null, rest: buffer };
    payloadLength = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + payloadLength) {
    return { frame: null, rest: buffer };
  }
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += maskLength;
  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return {
    frame: {
      opcode,
      payload,
    },
    rest: buffer.subarray(offset + payloadLength),
  };
}
