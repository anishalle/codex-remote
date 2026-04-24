import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { createCloudServer, type CloudServer } from "../../cloud-server/src/http.ts";
import { makeTestConfig } from "../../cloud-server/src/config.ts";
import type { MacRunnerConfig } from "../src/config.ts";
import { CONFIG_VERSION } from "../src/config.ts";
import { connectAndFlushOnce } from "../src/runner.ts";
import { RunnerStateDatabase } from "../src/state.ts";

const tempDirs: string[] = [];
const servers: CloudServer[] = [];

afterEach(async () => {
  const pendingServers = servers.splice(0);
  await Promise.all(pendingServers.map((server) => server.close()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cloudcodex-runner-test-"));
  tempDirs.push(dir);
  return dir;
}

function silentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

test("local queue persists pending and acked events across process restarts", () => {
  const dbPath = join(makeTempDir(), "state.db");
  const first = new RunnerStateDatabase(dbPath);
  const event = first.enqueueEvent({
    eventId: "event-persisted",
    projectName: "codex-remote",
    projectPath: "/tmp/codex-remote",
    threadId: "thread-persisted",
    type: "mock.codex.event",
    payload: { message: "persist me" },
    occurredAt: "2026-04-24T00:00:00.000Z",
  });
  first.markAttempted(event.eventId, "2026-04-24T00:00:01.000Z");
  first.close();

  const second = new RunnerStateDatabase(dbPath);
  const pending = second.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].eventId, "event-persisted");
  assert.equal(pending[0].attempts, 1);
  assert.equal(pending[0].lastAttemptAt, "2026-04-24T00:00:01.000Z");
  assert.deepEqual(pending[0].payload, { message: "persist me" });

  second.markAcked("event-persisted", 42, "2026-04-24T00:00:02.000Z");
  second.close();

  const third = new RunnerStateDatabase(dbPath);
  assert.equal(third.countPending(), 0);
  const acked = third.getEvent("event-persisted");
  assert.equal(acked?.ackedAt, "2026-04-24T00:00:02.000Z");
  assert.equal(acked?.remoteSequence, 42);
  third.close();
});

test("reconnect backfill sends attempted unacked events on the next connection", async () => {
  const cloudServer = createCloudServer(makeTestConfig());
  servers.push(cloudServer);
  const listening = await cloudServer.listen();
  const pairing = cloudServer.auth.createPairingToken({
    deviceKind: "runner",
    label: "runner",
  });
  const session = cloudServer.auth.finishPairing({
    pairingToken: pairing.pairingToken,
    deviceName: "test mac runner",
    deviceKind: "runner",
  });

  const config: MacRunnerConfig = {
    version: CONFIG_VERSION,
    serverUrl: listening.url,
    sessionToken: session.sessionToken,
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    deviceName: "test mac runner",
    runnerId: "runner-backfill",
    runnerName: "test mac runner",
    projects: {},
  };
  const state = new RunnerStateDatabase(join(makeTempDir(), "state.db"));
  const queued = state.enqueueEvent({
    eventId: "event-backfill",
    projectName: "codex-remote",
    projectPath: "/tmp/codex-remote",
    threadId: "thread-backfill",
    type: "mock.codex.event",
    payload: { afterReconnect: true },
    occurredAt: "2026-04-24T00:00:00.000Z",
  });
  state.markAttempted(queued.eventId, "2026-04-24T00:00:01.000Z");

  const result = await connectAndFlushOnce({
    config,
    state,
    timeoutMs: 5000,
    logger: silentLogger(),
  });
  assert.equal(result.sent, 1);
  assert.equal(result.acked, 1);
  assert.equal(state.countPending(), 0);
  assert.equal(state.getEvent("event-backfill")?.remoteSequence, 1);

  const events = cloudServer.db.listEvents({ runnerId: "runner-backfill" });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, "event-backfill");
  assert.equal(events[0].threadId, "thread-backfill");
  assert.deepEqual(events[0].payload, { afterReconnect: true });
  state.close();
});
