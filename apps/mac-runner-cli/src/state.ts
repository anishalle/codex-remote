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
  readonly localSequence?: number;
}

export interface QueuedEvent {
  readonly eventId: string;
  readonly projectName?: string;
  readonly projectPath?: string;
  readonly threadId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly localSequence: number | null;
  readonly queueSequence: number | null;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly attempts: number;
  readonly lastAttemptAt: string | null;
  readonly ackedAt: string | null;
  readonly remoteSequence: number | null;
}

export interface ThreadMapping {
  readonly cloudThreadId: string;
  readonly projectName: string;
  readonly projectPath: string;
  readonly providerThreadId: string | null;
  readonly status: string;
  readonly activeTurnId: string | null;
  readonly lastLocalSequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
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
    localSequence: row.local_sequence,
    queueSequence: row.queue_sequence,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    ackedAt: row.acked_at,
    remoteSequence: row.remote_sequence,
  };
}

function toThreadMapping(row: any): ThreadMapping {
  return {
    cloudThreadId: row.cloud_thread_id,
    projectName: row.project_name,
    projectPath: row.project_path,
    providerThreadId: row.provider_thread_id,
    status: row.status,
    activeTurnId: row.active_turn_id,
    lastLocalSequence: row.last_local_sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
        local_sequence INTEGER,
        queue_sequence INTEGER,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        acked_at TEXT,
        remote_sequence INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_outbound_events_pending
        ON outbound_events(acked_at, queue_sequence, created_at);

      CREATE TABLE IF NOT EXISTS thread_mappings (
        cloud_thread_id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        project_path TEXT NOT NULL,
        provider_thread_id TEXT,
        status TEXT NOT NULL,
        active_turn_id TEXT,
        last_local_sequence INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runner_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.addColumnIfMissing("outbound_events", "local_sequence", "INTEGER");
    this.addColumnIfMissing("outbound_events", "queue_sequence", "INTEGER");
  }

  enqueueEvent(input: QueuedEventInput): QueuedEvent {
    const eventId = input.eventId ?? `event_${randomUUID()}`;
    const occurredAt = input.occurredAt ?? nowIso();
    const createdAt = nowIso();
    const queueSequence = this.nextMetaSequence("queue");
    this.raw
      .prepare(
        `INSERT INTO outbound_events (
          event_id, project_name, project_path, thread_id, event_type, payload_json,
          local_sequence, queue_sequence, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        input.projectName ?? null,
        input.projectPath ?? null,
        input.threadId,
        input.type,
        json(input.payload),
        input.localSequence ?? null,
        queueSequence,
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
         ORDER BY queue_sequence ASC, created_at ASC
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

  upsertThreadMapping(input: {
    readonly cloudThreadId: string;
    readonly projectName: string;
    readonly projectPath: string;
    readonly providerThreadId?: string | null;
    readonly status: string;
    readonly activeTurnId?: string | null;
  }): ThreadMapping {
    const now = nowIso();
    this.raw
      .prepare(
        `INSERT INTO thread_mappings (
          cloud_thread_id, project_name, project_path, provider_thread_id, status,
          active_turn_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cloud_thread_id) DO UPDATE SET
          project_name = excluded.project_name,
          project_path = excluded.project_path,
          provider_thread_id = COALESCE(excluded.provider_thread_id, thread_mappings.provider_thread_id),
          status = excluded.status,
          active_turn_id = excluded.active_turn_id,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.cloudThreadId,
        input.projectName,
        input.projectPath,
        input.providerThreadId ?? null,
        input.status,
        input.activeTurnId ?? null,
        now,
        now,
      );
    const mapping = this.getThreadMapping(input.cloudThreadId);
    if (!mapping) {
      throw new Error(`Failed to upsert thread mapping ${input.cloudThreadId}.`);
    }
    return mapping;
  }

  getThreadMapping(cloudThreadId: string): ThreadMapping | null {
    const row = this.raw
      .prepare(`SELECT * FROM thread_mappings WHERE cloud_thread_id = ?`)
      .get(cloudThreadId);
    return row ? toThreadMapping(row) : null;
  }

  listThreadMappings(): ThreadMapping[] {
    const rows = this.raw
      .prepare(`SELECT * FROM thread_mappings ORDER BY updated_at DESC`)
      .all();
    return rows.map(toThreadMapping);
  }

  nextThreadLocalSequence(cloudThreadId: string): number {
    this.raw
      .prepare(
        `INSERT INTO thread_mappings (
          cloud_thread_id, project_name, project_path, status, created_at, updated_at
        ) VALUES (?, '', '', 'starting', ?, ?)
        ON CONFLICT(cloud_thread_id) DO NOTHING`,
      )
      .run(cloudThreadId, nowIso(), nowIso());
    this.raw
      .prepare(
        `UPDATE thread_mappings
         SET last_local_sequence = last_local_sequence + 1,
             updated_at = ?
         WHERE cloud_thread_id = ?`,
      )
      .run(nowIso(), cloudThreadId);
    const row = this.raw
      .prepare(`SELECT last_local_sequence FROM thread_mappings WHERE cloud_thread_id = ?`)
      .get(cloudThreadId) as { last_local_sequence: number };
    return row.last_local_sequence;
  }

  enqueueRuntimeEvent(input: Omit<QueuedEventInput, "eventId" | "localSequence">): QueuedEvent {
    const localSequence = this.nextThreadLocalSequence(input.threadId);
    return this.enqueueEvent({
      ...input,
      localSequence,
      eventId: `runtime_${input.threadId}_${localSequence}`,
    });
  }

  private nextMetaSequence(key: string): number {
    this.raw
      .prepare(
        `INSERT INTO runner_meta (key, value)
         VALUES (?, '0')
         ON CONFLICT(key) DO NOTHING`,
      )
      .run(key);
    this.raw
      .prepare(`UPDATE runner_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = ?`)
      .run(key);
    const row = this.raw
      .prepare(`SELECT value FROM runner_meta WHERE key = ?`)
      .get(key) as { value: string };
    return Number.parseInt(row.value, 10);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) {
      return;
    }
    this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
