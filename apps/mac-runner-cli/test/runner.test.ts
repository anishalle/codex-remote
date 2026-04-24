import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { createCloudServer, type CloudServer } from "../../cloud-server/src/http.ts";
import { makeTestConfig } from "../../cloud-server/src/config.ts";
import type { ProjectConfig, MacRunnerConfig } from "../src/config.ts";
import { CONFIG_VERSION } from "../src/config.ts";
import type { LocalRuntimeBridge, RuntimeStartTurnInput, RuntimeStartTurnResult } from "../src/local-codex.ts";
import { MacRunnerDaemon, connectAndFlushOnce } from "../src/runner.ts";
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

class FakeRuntimeBridge implements LocalRuntimeBridge {
  readonly starts: RuntimeStartTurnInput[] = [];

  async startTurn(input: RuntimeStartTurnInput): Promise<RuntimeStartTurnResult> {
    this.starts.push(input);
    input.onStatus({
      status: "running",
      providerThreadId: `codex-${input.cloudThreadId}`,
      activeTurnId: "turn-1",
    });
    input.onEvent({
      type: "codex.notification",
      payload: {
        method: "turn/started",
        providerThreadId: `codex-${input.cloudThreadId}`,
      },
    });
    input.onEvent({
      type: "codex.notification",
      payload: {
        method: "item/agentMessage/delta",
        delta: "hello",
        providerThreadId: `codex-${input.cloudThreadId}`,
      },
    });
    input.onStatus({
      status: "ready",
      providerThreadId: `codex-${input.cloudThreadId}`,
      activeTurnId: null,
    });
    return {
      providerThreadId: `codex-${input.cloudThreadId}`,
      activeTurnId: "turn-1",
    };
  }

  listThreads() {
    return this.starts.map((start) => ({
      cloudThreadId: start.cloudThreadId,
      providerThreadId: `codex-${start.cloudThreadId}`,
      status: "ready" as const,
    }));
  }

  async interruptTurn(): Promise<void> {}

  async resolveApproval(): Promise<void> {}

  async close(): Promise<void> {}
}

async function waitFor(assertion: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(assertion(), true);
}

function makeRunnerConfig(input: {
  readonly serverUrl: string;
  readonly sessionToken: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly project: ProjectConfig;
}): MacRunnerConfig {
  return {
    version: CONFIG_VERSION,
    serverUrl: input.serverUrl,
    sessionToken: input.sessionToken,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    deviceName: "test mac runner",
    runnerId: "runner-bridge",
    runnerName: "test mac runner",
    projects: {
      [input.project.name]: input.project,
    },
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

test("cloud turn command reaches local runtime and streams ordered events back", async () => {
  const cloudServer = createCloudServer(makeTestConfig());
  servers.push(cloudServer);
  const listening = await cloudServer.listen();
  const runnerPairing = cloudServer.auth.createPairingToken({
    deviceKind: "runner",
    label: "runner",
  });
  const runnerSession = cloudServer.auth.finishPairing({
    pairingToken: runnerPairing.pairingToken,
    deviceName: "test mac runner",
    deviceKind: "runner",
  });
  const ownerPairing = cloudServer.auth.createPairingToken({
    deviceKind: "owner",
    label: "owner",
  });
  const ownerSession = cloudServer.auth.finishPairing({
    pairingToken: ownerPairing.pairingToken,
    deviceName: "owner",
    deviceKind: "owner",
  });

  const workspaceRoot = realpathSync(makeTempDir());
  const project: ProjectConfig = {
    name: "codex-remote",
    path: workspaceRoot,
    addedAt: new Date().toISOString(),
  };
  const state = new RunnerStateDatabase(join(makeTempDir(), "state.db"));
  const runtimeBridge = new FakeRuntimeBridge();
  const controller = new AbortController();
  const daemon = new MacRunnerDaemon({
    config: makeRunnerConfig({
      serverUrl: listening.url,
      sessionToken: runnerSession.sessionToken,
      sessionId: runnerSession.sessionId,
      deviceId: runnerSession.deviceId,
      project,
    }),
    state,
    options: {
      signal: controller.signal,
      flushIntervalMs: 20,
      heartbeatIntervalMs: 1000,
      reconnectBaseMs: 20,
      runtimeBridge,
      logger: silentLogger(),
    },
  });
  const daemonRun = daemon.run();

  try {
    await waitFor(() => {
      const row = cloudServer.db.raw
        .prepare("SELECT connected FROM runners WHERE runner_id = ?")
        .get("runner-bridge") as { connected: number } | undefined;
      return row?.connected === 1;
    });

    const response = await fetch(`${listening.url}/api/turns/start`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerSession.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runnerId: "runner-bridge",
        projectId: project.name,
        prompt: "Use the real runtime bridge",
      }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as any;
    assert.match(body.cloudThreadId, /^thread_/);

    await waitFor(() => cloudServer.db.listEvents({ threadId: body.cloudThreadId }).length === 2);
    const events = cloudServer.db.listEvents({ threadId: body.cloudThreadId });
    assert.equal(events[0].payload.localSequence, 1);
    assert.equal(events[1].payload.localSequence, 2);
    assert.equal(events[0].payload.data.method, "turn/started");
    assert.equal(events[1].payload.data.method, "item/agentMessage/delta");

    const thread = cloudServer.db.getThread(body.cloudThreadId);
    assert.equal(thread?.status, "ready");
    assert.equal(thread?.providerThreadId, `codex-${body.cloudThreadId}`);
    assert.equal(thread?.lastEventSequence, 2);
    assert.equal(runtimeBridge.starts.length, 1);
    assert.equal(runtimeBridge.starts[0].project.path, workspaceRoot);
  } finally {
    controller.abort();
    await daemonRun;
    state.close();
  }
});

test("runner rejects cloud turn commands for unregistered projects before runtime start", async () => {
  const cloudServer = createCloudServer(makeTestConfig());
  servers.push(cloudServer);
  const listening = await cloudServer.listen();
  const runnerPairing = cloudServer.auth.createPairingToken({
    deviceKind: "runner",
    label: "runner",
  });
  const runnerSession = cloudServer.auth.finishPairing({
    pairingToken: runnerPairing.pairingToken,
    deviceName: "test mac runner",
    deviceKind: "runner",
  });
  const ownerPairing = cloudServer.auth.createPairingToken({
    deviceKind: "owner",
    label: "owner",
  });
  const ownerSession = cloudServer.auth.finishPairing({
    pairingToken: ownerPairing.pairingToken,
    deviceName: "owner",
    deviceKind: "owner",
  });

  const workspaceRoot = realpathSync(makeTempDir());
  const project: ProjectConfig = {
    name: "codex-remote",
    path: workspaceRoot,
    addedAt: new Date().toISOString(),
  };
  const state = new RunnerStateDatabase(join(makeTempDir(), "state.db"));
  const runtimeBridge = new FakeRuntimeBridge();
  const controller = new AbortController();
  const daemon = new MacRunnerDaemon({
    config: makeRunnerConfig({
      serverUrl: listening.url,
      sessionToken: runnerSession.sessionToken,
      sessionId: runnerSession.sessionId,
      deviceId: runnerSession.deviceId,
      project,
    }),
    state,
    options: {
      signal: controller.signal,
      flushIntervalMs: 20,
      heartbeatIntervalMs: 1000,
      reconnectBaseMs: 20,
      runtimeBridge,
      logger: silentLogger(),
    },
  });
  const daemonRun = daemon.run();

  try {
    await waitFor(() => {
      const row = cloudServer.db.raw
        .prepare("SELECT connected FROM runners WHERE runner_id = ?")
        .get("runner-bridge") as { connected: number } | undefined;
      return row?.connected === 1;
    });

    const response = await fetch(`${listening.url}/api/turns/start`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerSession.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runnerId: "runner-bridge",
        projectId: "../not-registered",
        prompt: "do not run",
      }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as any;

    await waitFor(() => cloudServer.db.getThread(body.cloudThreadId)?.status === "error");
    assert.equal(runtimeBridge.starts.length, 0);
    assert.equal(cloudServer.db.listEvents({ threadId: body.cloudThreadId }).length, 0);
  } finally {
    controller.abort();
    await daemonRun;
    state.close();
  }
});
