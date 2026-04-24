import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import { afterEach, test } from "node:test";

import { createEnvelope, type Envelope } from "../../../packages/protocol/src/index.ts";
import { makeTestConfig, type CloudServerConfig } from "../src/config.ts";
import { createCloudServer, type CloudServer } from "../src/http.ts";

const servers: CloudServer[] = [];

afterEach(async () => {
  const pending = servers.splice(0);
  await Promise.all(pending.map((server) => server.close()));
});

async function startServer(overrides: Partial<CloudServerConfig> = {}) {
  const server = createCloudServer(makeTestConfig(overrides));
  servers.push(server);
  const listening = await server.listen();
  return { server, baseUrl: listening.url };
}

async function readJson(response: Response): Promise<any> {
  return response.json();
}

async function postJson(baseUrl: string, path: string, body: unknown, headers: HeadersInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function pairDevice(baseUrl: string, deviceKind: "runner" | "client" | "owner") {
  const createResponse = await postJson(
    baseUrl,
    "/api/pairing-tokens",
    {
      deviceKind,
      label: `${deviceKind}-test`,
    },
    { "x-bootstrap-token": "test-bootstrap-token" },
  );
  assert.equal(createResponse.status, 201);
  const created = await readJson(createResponse);

  const finishResponse = await postJson(baseUrl, "/api/pairing/finish", {
    pairingToken: created.pairingToken,
    deviceName: `${deviceKind} device`,
    deviceKind,
  });
  assert.equal(finishResponse.status, 200);
  return readJson(finishResponse);
}

function encodeClientFrame(raw: string): Buffer {
  const payload = Buffer.from(raw, "utf8");
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length <= 0xFFFF) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeServerFrame(buffer: Buffer): {
  readonly frame: { readonly opcode: number; readonly payload: Buffer } | null;
  readonly rest: Buffer;
} {
  if (buffer.length < 2) return { frame: null, rest: buffer };
  const first = buffer[0];
  const second = buffer[1];
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
  const masked = (second & 0x80) !== 0;
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
      opcode: first & 0x0F,
      payload,
    },
    rest: buffer.subarray(offset + payloadLength),
  };
}

class RawWebSocket {
  readonly socket: net.Socket;
  private buffer: Buffer;
  private readonly waiters: Array<{
    readonly resolve: (value: string) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }> = [];
  private closedError: Error | null = null;

  constructor(socket: net.Socket, initialBuffer = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = initialBuffer;
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.resolvePendingReads();
    });
    this.socket.on("end", () => this.failPendingReads(new Error("Socket ended.")));
    this.socket.on("error", (error) => this.failPendingReads(error));
  }

  sendJson(value: unknown): void {
    this.socket.write(encodeClientFrame(JSON.stringify(value)));
  }

  async readJson(timeoutMs = 1000): Promise<any> {
    const raw = await this.readText(timeoutMs);
    return JSON.parse(raw);
  }

  close(): void {
    this.socket.end();
  }

  private async readText(timeoutMs: number): Promise<string> {
    const immediate = this.tryReadText();
    if (immediate !== null) {
      return immediate;
    }
    if (this.closedError) {
      throw this.closedError;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(resolve);
        reject(new Error("Timed out waiting for WebSocket data."));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private tryReadText(): string | null {
    while (true) {
      const decoded = decodeServerFrame(this.buffer);
      if (decoded.frame) {
        this.buffer = decoded.rest;
        if (decoded.frame.opcode === 0x1) {
          return decoded.frame.payload.toString("utf8");
        }
        if (decoded.frame.opcode === 0x8) {
          this.closedError = new Error("WebSocket closed.");
          return null;
        }
        continue;
      }
      return null;
    }
  }

  private resolvePendingReads(): void {
    while (this.waiters.length > 0) {
      const text = this.tryReadText();
      if (text === null) return;
      const waiter = this.waiters.shift();
      if (!waiter) return;
      clearTimeout(waiter.timer);
      waiter.resolve(text);
    }
  }

  private failPendingReads(error: Error): void {
    this.closedError = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private removeWaiter(resolve: (value: string) => void): void {
    const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
    if (index !== -1) {
      this.waiters.splice(index, 1);
    }
  }
}

async function waitForSocketData(socket: net.Socket, timeoutMs: number): Promise<Buffer> {
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
      reject(new Error("Socket ended before data was available."));
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

async function readUpgradeResponse(socket: net.Socket): Promise<{
  readonly statusCode: number;
  readonly header: string;
  readonly rest: Buffer;
}> {
  let buffer = Buffer.alloc(0);
  while (true) {
    const chunk = await waitForSocketData(socket, 1000);
    buffer = Buffer.concat([buffer, chunk]);
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const statusCode = Number.parseInt(header.split(" ")[1] ?? "0", 10);
      return {
        statusCode,
        header,
        rest: buffer.subarray(headerEnd + 4),
      };
    }
  }
}

async function openRawSocket(baseUrl: string): Promise<net.Socket> {
  const url = new URL(baseUrl);
  const socket = net.createConnection({
    host: url.hostname,
    port: Number.parseInt(url.port, 10),
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function connectWebSocket(input: {
  readonly baseUrl: string;
  readonly path: string;
  readonly token?: string;
}): Promise<RawWebSocket> {
  const url = new URL(input.baseUrl);
  const socket = await openRawSocket(input.baseUrl);
  const headers = [
    `GET ${input.path} HTTP/1.1`,
    `Host: ${url.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "Sec-WebSocket-Version: 13",
  ];
  if (input.token) {
    headers.push(`Authorization: Bearer ${input.token}`);
  }
  socket.write(`${headers.join("\r\n")}\r\n\r\n`);
  const response = await readUpgradeResponse(socket);
  assert.equal(response.statusCode, 101, response.header);
  return new RawWebSocket(socket, response.rest);
}

function testEnvelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
): Envelope<TType, TPayload> {
  return createEnvelope(type, payload, { id: randomUUID() });
}

test("pairing finish issues hashed session tokens and authenticates the session", async () => {
  const { server, baseUrl } = await startServer();

  const createResponse = await postJson(
    baseUrl,
    "/api/pairing-tokens",
    { deviceKind: "client", label: "phone" },
    { "x-bootstrap-token": "test-bootstrap-token" },
  );
  assert.equal(createResponse.status, 201);
  const created = await readJson(createResponse);

  const finishResponse = await postJson(baseUrl, "/api/pairing/finish", {
    pairingToken: created.pairingToken,
    deviceName: "test phone",
    deviceKind: "client",
  });
  assert.equal(finishResponse.status, 200);
  const session = await readJson(finishResponse);
  assert.equal(session.deviceKind, "client");
  assert.match(session.sessionToken, /^ccs_/);

  const sessionResponse = await fetch(`${baseUrl}/api/session`, {
    headers: { authorization: `Bearer ${session.sessionToken}` },
  });
  assert.equal(sessionResponse.status, 200);
  assert.equal((await readJson(sessionResponse)).deviceId, session.deviceId);

  const pairingRow = server.db.raw
    .prepare("SELECT token_hash FROM pairing_tokens WHERE id = ?")
    .get(created.id) as { token_hash: string };
  const sessionRow = server.db.raw
    .prepare("SELECT token_hash FROM sessions WHERE session_id = ?")
    .get(session.sessionId) as { token_hash: string };
  assert.notEqual(pairingRow.token_hash, created.pairingToken);
  assert.notEqual(sessionRow.token_hash, session.sessionToken);
  assert(!pairingRow.token_hash.includes(created.pairingToken));
  assert(!sessionRow.token_hash.includes(session.sessionToken));
});

test("expired pairing tokens cannot be finished", async () => {
  const { baseUrl } = await startServer();

  const createResponse = await postJson(
    baseUrl,
    "/api/pairing-tokens",
    { deviceKind: "runner", label: "expired", ttlSeconds: -1 },
    { "x-bootstrap-token": "test-bootstrap-token" },
  );
  assert.equal(createResponse.status, 201);
  const created = await readJson(createResponse);

  const finishResponse = await postJson(baseUrl, "/api/pairing/finish", {
    pairingToken: created.pairingToken,
    deviceName: "late runner",
    deviceKind: "runner",
  });
  assert.equal(finishResponse.status, 401);
  const body = await readJson(finishResponse);
  assert.equal(body.error.code, "pairing_token_expired");
});

test("WebSocket upgrade without authentication fails before protocol acceptance", async () => {
  const { baseUrl } = await startServer();
  const url = new URL(baseUrl);
  const socket = await openRawSocket(baseUrl);
  socket.write(
    [
      "GET /ws/client HTTP/1.1",
      `Host: ${url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      "Sec-WebSocket-Version: 13",
      "\r\n",
    ].join("\r\n"),
  );
  const response = await readUpgradeResponse(socket);
  assert.equal(response.statusCode, 401, response.header);
  socket.destroy();
});

test("runner WebSocket appends mocked events and client WebSocket lists them", { timeout: 5000 }, async () => {
  const { baseUrl } = await startServer();
  const runnerSession = await pairDevice(baseUrl, "runner");
  const clientSession = await pairDevice(baseUrl, "client");
  let runner: RawWebSocket | null = null;
  let client: RawWebSocket | null = null;

  try {
    runner = await connectWebSocket({
      baseUrl,
      path: "/ws/runner",
      token: runnerSession.sessionToken,
    });

    runner.sendJson(
      testEnvelope("runner.hello", {
        runnerId: "runner-1",
        name: "mock runner",
        version: "test",
        capabilities: ["mock-events"],
      }),
    );
    const helloAck = await runner.readJson();
    assert.equal(helloAck.type, "runner.hello.ack");
    assert.equal(helloAck.payload.runnerId, "runner-1");

    runner.sendJson(
      testEnvelope("runner.event.append", {
        eventId: "event-1",
        threadId: "thread-1",
        type: "mock.codex.event",
        payload: { text: "hello from mock runner" },
        occurredAt: new Date().toISOString(),
      }),
    );
    const eventAck = await runner.readJson();
    assert.equal(eventAck.type, "runner.event.ack");
    assert.equal(eventAck.payload.eventId, "event-1");
    assert.equal(eventAck.payload.sequence, 1);

    client = await connectWebSocket({
      baseUrl,
      path: "/ws/client",
      token: clientSession.sessionToken,
    });
    client.sendJson(testEnvelope("events.list", { afterSequence: 0, limit: 10 }));
    const eventList = await client.readJson();
    assert.equal(eventList.type, "events.list.result");
    assert.equal(eventList.payload.events.length, 1);
    assert.equal(eventList.payload.events[0].eventId, "event-1");
    assert.equal(eventList.payload.events[0].runnerId, "runner-1");
    assert.equal(eventList.payload.events[0].type, "mock.codex.event");
    assert.deepEqual(eventList.payload.events[0].payload, { text: "hello from mock runner" });
  } finally {
    runner?.close();
    client?.close();
  }
});
