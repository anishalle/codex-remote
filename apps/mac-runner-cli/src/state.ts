import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface QueuedEventInput {
  readonly eventId?: string;
  readonly projectName?: string;
  readonly projectPath?: string;
  readonly threadId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAt?: string;
}

export interface QueuedEvent {
  readonly eventId: string;
  readonly projectName?: string;
  readonly projectPath?: string;
  readonly threadId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly attempts: number;
  readonly lastAttemptAt: string | null;
  readonly ackedAt: string | null;
  readonly remoteSequence: number | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

function maybeCreateParentDirectory(dbPath: string): void {
  if (dbPath === ":memory:") return;
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
}

function toQueuedEvent(row: any): QueuedEvent {
  return {
    eventId: row.event_id,
    projectName: row.project_name ?? undefined,
    projectPath: row.project_path ?? undefined,
    threadId: row.thread_id,
    type: row.event_type,
    payload: parseJson(row.payload_json),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    ackedAt: row.acked_at,
    remoteSequence: row.remote_sequence,
  };
}

export class RunnerStateDatabase {
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

      CREATE TABLE IF NOT EXISTS outbound_events (
        event_id TEXT PRIMARY KEY,
        project_name TEXT,
        project_path TEXT,
        thread_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        acked_at TEXT,
        remote_sequence INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_outbound_events_pending
        ON outbound_events(acked_at, created_at);
    `);
  }

  enqueueEvent(input: QueuedEventInput): QueuedEvent {
    const eventId = input.eventId ?? `event_${randomUUID()}`;
    const occurredAt = input.occurredAt ?? nowIso();
    const createdAt = nowIso();
    this.raw
      .prepare(
        `INSERT INTO outbound_events (
          event_id, project_name, project_path, thread_id, event_type, payload_json,
          occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        input.projectName ?? null,
        input.projectPath ?? null,
        input.threadId,
        input.type,
        json(input.payload),
        occurredAt,
        createdAt,
      );
    const created = this.getEvent(eventId);
    if (!created) {
      throw new Error(`Failed to enqueue event ${eventId}.`);
    }
    return created;
  }

  getEvent(eventId: string): QueuedEvent | null {
    const row = this.raw
      .prepare(`SELECT * FROM outbound_events WHERE event_id = ?`)
      .get(eventId);
    return row ? toQueuedEvent(row) : null;
  }

  listPending(limit = 100): QueuedEvent[] {
    const rows = this.raw
      .prepare(
        `SELECT * FROM outbound_events
         WHERE acked_at IS NULL
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 500));
    return rows.map(toQueuedEvent);
  }

  countPending(): number {
    const row = this.raw
      .prepare(`SELECT COUNT(*) AS count FROM outbound_events WHERE acked_at IS NULL`)
      .get() as { count: number };
    return row.count;
  }

  markAttempted(eventId: string, attemptedAt = nowIso()): void {
    this.raw
      .prepare(
        `UPDATE outbound_events
         SET attempts = attempts + 1, last_attempt_at = ?
         WHERE event_id = ? AND acked_at IS NULL`,
      )
      .run(attemptedAt, eventId);
  }

  markAcked(eventId: string, remoteSequence: number, ackedAt = nowIso()): void {
    this.raw
      .prepare(
        `UPDATE outbound_events
         SET acked_at = ?, remote_sequence = ?
         WHERE event_id = ?`,
      )
      .run(ackedAt, remoteSequence, eventId);
  }
}
