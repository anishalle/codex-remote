import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { CloudEvent } from "../../../packages/protocol/src/index.ts";

export interface AuditRecordInput {
  readonly actorKind: "bootstrap" | "device" | "anonymous" | "system";
  readonly actorDeviceId?: string | null;
  readonly action: string;
  readonly targetKind?: string | null;
  readonly targetId?: string | null;
  readonly ok: boolean;
  readonly detail?: Record<string, unknown>;
}

export interface CreatePairingTokenRow {
  readonly id: string;
  readonly tokenHash: string;
  readonly deviceKind: "runner" | "client" | "owner";
  readonly label: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly createdByDeviceId: string | null;
}

export interface PairingTokenRow extends CreatePairingTokenRow {
  readonly consumedAt: string | null;
  readonly consumedByDeviceId: string | null;
  readonly revokedAt: string | null;
}

export interface DeviceRow {
  readonly deviceId: string;
  readonly deviceKind: "runner" | "client" | "owner";
  readonly name: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface SessionRow {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly tokenHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface VerifiedSessionRow {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceKind: "runner" | "client" | "owner";
  readonly deviceName: string;
  readonly expiresAt: string;
}

export interface AppendEventInput {
  readonly eventId: string;
  readonly runnerId: string;
  readonly projectId?: string;
  readonly threadId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAt: string;
  readonly receivedAt: string;
}

export interface ListEventsInput {
  readonly runnerId?: string;
  readonly threadId?: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

function maybeCreateParentDirectory(dbPath: string): void {
  if (dbPath === ":memory:") return;
  mkdirSync(dirname(dbPath), { recursive: true });
}

function toPairingTokenRow(row: any): PairingTokenRow {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    deviceKind: row.device_kind,
    label: row.label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    createdByDeviceId: row.created_by_device_id,
    consumedAt: row.consumed_at,
    consumedByDeviceId: row.consumed_by_device_id,
    revokedAt: row.revoked_at,
  };
}

function toCloudEvent(row: any): CloudEvent {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    runnerId: row.runner_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    threadId: row.thread_id,
    type: row.event_type,
    payload: parseJson(row.payload_json),
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
  };
}

export class CloudDatabase {
  readonly raw: DatabaseSync;

  constructor(dbPath: string) {
    maybeCreateParentDirectory(dbPath);
    this.raw = new DatabaseSync(dbPath);
    this.migrate();
  }

  close(): void {
    this.raw.close();
  }

  migrate(): void {
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS pairing_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        device_kind TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_by_device_id TEXT,
        consumed_at TEXT,
        consumed_by_device_id TEXT,
        revoked_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pairing_tokens_available
        ON pairing_tokens(token_hash, expires_at, consumed_at, revoked_at);

      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        device_kind TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT,
        FOREIGN KEY (device_id) REFERENCES devices(device_id)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_token_hash
        ON sessions(token_hash);

      CREATE INDEX IF NOT EXISTS idx_sessions_active
        ON sessions(revoked_at, expires_at);

      CREATE TABLE IF NOT EXISTS runners (
        runner_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT,
        capabilities_json TEXT NOT NULL,
        connected INTEGER NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY (device_id) REFERENCES devices(device_id)
      );

      CREATE TABLE IF NOT EXISTS cloud_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        runner_id TEXT NOT NULL,
        project_id TEXT,
        thread_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cloud_events_thread_sequence
        ON cloud_events(thread_id, sequence);

      CREATE INDEX IF NOT EXISTS idx_cloud_events_runner_sequence
        ON cloud_events(runner_id, sequence);

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_device_id TEXT,
        action TEXT NOT NULL,
        target_kind TEXT,
        target_id TEXT,
        ok INTEGER NOT NULL,
        detail_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at
        ON audit_log(occurred_at);
    `);
  }

  createPairingToken(row: CreatePairingTokenRow): void {
    this.raw
      .prepare(
        `INSERT INTO pairing_tokens (
          id, token_hash, device_kind, label, created_at, expires_at, created_by_device_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.tokenHash,
        row.deviceKind,
        row.label,
        row.createdAt,
        row.expiresAt,
        row.createdByDeviceId,
      );
  }

  getPairingTokenByHash(tokenHash: string): PairingTokenRow | null {
    const row = this.raw
      .prepare(`SELECT * FROM pairing_tokens WHERE token_hash = ?`)
      .get(tokenHash);
    return row ? toPairingTokenRow(row) : null;
  }

  consumePairingToken(input: {
    readonly id: string;
    readonly consumedAt: string;
    readonly consumedByDeviceId: string;
  }): void {
    this.raw
      .prepare(
        `UPDATE pairing_tokens
         SET consumed_at = ?, consumed_by_device_id = ?
         WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
      )
      .run(input.consumedAt, input.consumedByDeviceId, input.id);
  }

  createDevice(row: Omit<DeviceRow, "revokedAt">): void {
    this.raw
      .prepare(
        `INSERT INTO devices (device_id, device_kind, name, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(row.deviceId, row.deviceKind, row.name, row.createdAt);
  }

  createSession(row: SessionRow): void {
    this.raw
      .prepare(
        `INSERT INTO sessions (session_id, device_id, token_hash, issued_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.sessionId, row.deviceId, row.tokenHash, row.issuedAt, row.expiresAt, row.revokedAt);
  }

  getSessionByTokenHash(tokenHash: string, now: string): VerifiedSessionRow | null {
    const row = this.raw
      .prepare(
        `SELECT
          sessions.session_id AS session_id,
          sessions.device_id AS device_id,
          devices.device_kind AS device_kind,
          devices.name AS device_name,
          sessions.expires_at AS expires_at
        FROM sessions
        INNER JOIN devices ON devices.device_id = sessions.device_id
        WHERE sessions.token_hash = ?
          AND sessions.revoked_at IS NULL
          AND sessions.expires_at > ?
          AND devices.revoked_at IS NULL`,
      )
      .get(tokenHash, now);
    if (!row) return null;
    this.raw
      .prepare(`UPDATE sessions SET last_used_at = ? WHERE session_id = ?`)
      .run(now, row.session_id);
    return {
      sessionId: row.session_id,
      deviceId: row.device_id,
      deviceKind: row.device_kind,
      deviceName: row.device_name,
      expiresAt: row.expires_at,
    };
  }

  upsertRunner(input: {
    readonly runnerId: string;
    readonly deviceId: string;
    readonly name: string;
    readonly version?: string;
    readonly capabilities?: readonly string[];
    readonly connected: boolean;
    readonly lastSeenAt: string;
  }): void {
    this.raw
      .prepare(
        `INSERT INTO runners (
          runner_id, device_id, name, version, capabilities_json, connected, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(runner_id) DO UPDATE SET
          device_id = excluded.device_id,
          name = excluded.name,
          version = excluded.version,
          capabilities_json = excluded.capabilities_json,
          connected = excluded.connected,
          last_seen_at = excluded.last_seen_at`,
      )
      .run(
        input.runnerId,
        input.deviceId,
        input.name,
        input.version ?? null,
        json(input.capabilities ?? []),
        input.connected ? 1 : 0,
        input.lastSeenAt,
      );
  }

  markRunnerDisconnected(input: { readonly runnerId: string; readonly lastSeenAt: string }): void {
    this.raw
      .prepare(`UPDATE runners SET connected = 0, last_seen_at = ? WHERE runner_id = ?`)
      .run(input.lastSeenAt, input.runnerId);
  }

  appendEvent(input: AppendEventInput): CloudEvent {
    this.raw
      .prepare(
        `INSERT INTO cloud_events (
          event_id, runner_id, project_id, thread_id, event_type, payload_json, occurred_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.eventId,
        input.runnerId,
        input.projectId ?? null,
        input.threadId,
        input.type,
        json(input.payload),
        input.occurredAt,
        input.receivedAt,
      );

    const row = this.raw
      .prepare(`SELECT * FROM cloud_events WHERE event_id = ?`)
      .get(input.eventId);
    return toCloudEvent(row);
  }

  getEventById(eventId: string): CloudEvent | null {
    const row = this.raw
      .prepare(`SELECT * FROM cloud_events WHERE event_id = ?`)
      .get(eventId);
    return row ? toCloudEvent(row) : null;
  }

  listEvents(input: ListEventsInput = {}): CloudEvent[] {
    const clauses = ["sequence > ?"];
    const params: unknown[] = [input.afterSequence ?? 0];
    if (input.runnerId) {
      clauses.push("runner_id = ?");
      params.push(input.runnerId);
    }
    if (input.threadId) {
      clauses.push("thread_id = ?");
      params.push(input.threadId);
    }
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    params.push(limit);
    const rows = this.raw
      .prepare(
        `SELECT * FROM cloud_events
         WHERE ${clauses.join(" AND ")}
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(...params);
    return rows.map(toCloudEvent);
  }

  appendAudit(input: AuditRecordInput): void {
    this.raw
      .prepare(
        `INSERT INTO audit_log (
          id, occurred_at, actor_kind, actor_device_id, action, target_kind, target_id, ok, detail_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        new Date().toISOString(),
        input.actorKind,
        input.actorDeviceId ?? null,
        input.action,
        input.targetKind ?? null,
        input.targetId ?? null,
        input.ok ? 1 : 0,
        json(input.detail ?? {}),
      );
  }
}
