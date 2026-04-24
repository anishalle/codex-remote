import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  ApprovalDecision,
  ApprovalStatus,
  CloudEvent,
  PendingApprovalSummary,
  ProjectSummary,
  RunnerSummary,
  ThreadStatus,
  ThreadSummary,
} from "../../../packages/protocol/src/index.ts";

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

export interface CreateThreadInput {
  readonly cloudThreadId: string;
  readonly runnerId: string;
  readonly projectId: string;
  readonly status: ThreadStatus;
  readonly createdAt: string;
}

export interface UpdateThreadStatusInput {
  readonly cloudThreadId: string;
  readonly status: ThreadStatus;
  readonly providerThreadId?: string;
  readonly activeTurnId?: string | null;
  readonly lastEventSequence?: number;
  readonly updatedAt: string;
}

export interface ListThreadsInput {
  readonly runnerId?: string;
  readonly projectId?: string;
  readonly limit?: number;
}

export interface CreateRunnerCommandInput {
  readonly commandId: string;
  readonly runnerId: string;
  readonly cloudThreadId: string;
  readonly commandType: string;
  readonly status: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface RunnerCommandRow {
  readonly commandId: string;
  readonly runnerId: string;
  readonly cloudThreadId: string;
  readonly commandType: string;
  readonly status: string;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertProjectInput {
  readonly projectId: string;
  readonly runnerId: string;
  readonly name: string;
  readonly lastSeenAt: string;
}

export interface UpsertPendingApprovalInput {
  readonly approvalId: string;
  readonly runnerId: string;
  readonly cloudThreadId: string;
  readonly projectId: string;
  readonly approvalType: string;
  readonly status: ApprovalStatus;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface ResolvePendingApprovalInput {
  readonly approvalId: string;
  readonly status: ApprovalStatus;
  readonly decision: ApprovalDecision;
  readonly resolvedAt: string;
}

export interface CreateUploadInput {
  readonly uploadId: string;
  readonly runnerId: string;
  readonly projectId: string;
  readonly actorDeviceId: string;
  readonly status: string;
  readonly filePath: string;
  readonly totalBytes: number;
  readonly expectedSha256?: string | null;
  readonly manifest: unknown;
  readonly handoffPrompt?: string | null;
  readonly createdAt: string;
}

export interface HandoffUploadRow {
  readonly uploadId: string;
  readonly runnerId: string;
  readonly projectId: string;
  readonly actorDeviceId: string;
  readonly status: string;
  readonly filePath: string;
  readonly totalBytes: number;
  readonly receivedBytes: number;
  readonly expectedSha256: string | null;
  readonly actualSha256: string | null;
  readonly manifest: unknown;
  readonly handoffPrompt: string | null;
  readonly commandId: string | null;
  readonly cloudThreadId: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly unpackedAt: string | null;
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

function toThreadSummary(row: any): ThreadSummary {
  return {
    cloudThreadId: row.cloud_thread_id,
    runnerId: row.runner_id,
    projectId: row.project_id,
    status: row.status,
    ...(row.provider_thread_id ? { providerThreadId: row.provider_thread_id } : {}),
    ...(row.active_turn_id ? { activeTurnId: row.active_turn_id } : {}),
    ...(row.last_event_sequence !== null ? { lastEventSequence: row.last_event_sequence } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRunnerSummary(row: any): RunnerSummary {
  return {
    runnerId: row.runner_id,
    name: row.name,
    ...(row.version ? { version: row.version } : {}),
    capabilities: parseJson(row.capabilities_json) as string[],
    connected: row.connected === 1,
    lastSeenAt: row.last_seen_at,
  };
}

function toProjectSummary(row: any): ProjectSummary {
  return {
    projectId: row.project_id,
    runnerId: row.runner_id,
    name: row.name,
    lastSeenAt: row.last_seen_at,
  };
}

function toPendingApprovalSummary(row: any): PendingApprovalSummary {
  return {
    approvalId: row.approval_id,
    runnerId: row.runner_id,
    cloudThreadId: row.cloud_thread_id,
    projectId: row.project_id,
    approvalType: row.approval_type,
    status: row.status,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    ...(row.decision ? { decision: row.decision } : {}),
  };
}

function toRunnerCommandRow(row: any): RunnerCommandRow {
  return {
    commandId: row.command_id,
    runnerId: row.runner_id,
    cloudThreadId: row.cloud_thread_id,
    commandType: row.command_type,
    status: row.status,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toHandoffUploadRow(row: any): HandoffUploadRow {
  return {
    uploadId: row.upload_id,
    runnerId: row.runner_id,
    projectId: row.project_id,
    actorDeviceId: row.actor_device_id,
    status: row.status,
    filePath: row.file_path,
    totalBytes: row.total_bytes,
    receivedBytes: row.received_bytes,
    expectedSha256: row.expected_sha256,
    actualSha256: row.actual_sha256,
    manifest: parseJson(row.manifest_json),
    handoffPrompt: row.handoff_prompt,
    commandId: row.command_id,
    cloudThreadId: row.cloud_thread_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    unpackedAt: row.unpacked_at,
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

      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (runner_id, project_id),
        FOREIGN KEY (runner_id) REFERENCES runners(runner_id)
      );

      CREATE INDEX IF NOT EXISTS idx_projects_project_id
        ON projects(project_id);

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

      CREATE TABLE IF NOT EXISTS threads (
        cloud_thread_id TEXT PRIMARY KEY,
        runner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        provider_thread_id TEXT,
        status TEXT NOT NULL,
        active_turn_id TEXT,
        last_event_sequence INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_threads_runner_updated
        ON threads(runner_id, updated_at);

      CREATE INDEX IF NOT EXISTS idx_threads_project_updated
        ON threads(project_id, updated_at);

      CREATE TABLE IF NOT EXISTS runner_commands (
        command_id TEXT PRIMARY KEY,
        runner_id TEXT NOT NULL,
        cloud_thread_id TEXT NOT NULL,
        command_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (cloud_thread_id) REFERENCES threads(cloud_thread_id)
      );

      CREATE INDEX IF NOT EXISTS idx_runner_commands_thread_created
        ON runner_commands(cloud_thread_id, created_at);

      CREATE TABLE IF NOT EXISTS pending_approvals (
        approval_id TEXT PRIMARY KEY,
        runner_id TEXT NOT NULL,
        cloud_thread_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        approval_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        decision TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pending_approvals_status_created
        ON pending_approvals(status, created_at);

      CREATE INDEX IF NOT EXISTS idx_pending_approvals_thread
        ON pending_approvals(cloud_thread_id, created_at);

      CREATE TABLE IF NOT EXISTS handoff_uploads (
        upload_id TEXT PRIMARY KEY,
        runner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        actor_device_id TEXT NOT NULL,
        status TEXT NOT NULL,
        file_path TEXT NOT NULL,
        total_bytes INTEGER NOT NULL,
        received_bytes INTEGER NOT NULL DEFAULT 0,
        expected_sha256 TEXT,
        actual_sha256 TEXT,
        manifest_json TEXT NOT NULL,
        handoff_prompt TEXT,
        command_id TEXT,
        cloud_thread_id TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        unpacked_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_handoff_uploads_runner_status
        ON handoff_uploads(runner_id, status, created_at);

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

  listRunners(): RunnerSummary[] {
    const rows = this.raw
      .prepare(`SELECT * FROM runners ORDER BY connected DESC, last_seen_at DESC`)
      .all();
    return rows.map(toRunnerSummary);
  }

  upsertProject(input: UpsertProjectInput): void {
    this.raw
      .prepare(
        `INSERT INTO projects (project_id, runner_id, name, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(runner_id, project_id) DO UPDATE SET
           name = excluded.name,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(input.projectId, input.runnerId, input.name, input.lastSeenAt);
  }

  listProjects(input: { readonly runnerId?: string } = {}): ProjectSummary[] {
    const rows = input.runnerId
      ? this.raw
          .prepare(`SELECT * FROM projects WHERE runner_id = ? ORDER BY name ASC`)
          .all(input.runnerId)
      : this.raw.prepare(`SELECT * FROM projects ORDER BY name ASC`).all();
    return rows.map(toProjectSummary);
  }

  deleteProject(input: { readonly runnerId: string; readonly projectId: string }): boolean {
    const result = this.raw
      .prepare(`DELETE FROM projects WHERE runner_id = ? AND project_id = ?`)
      .run(input.runnerId, input.projectId);
    return result.changes > 0;
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

  createThread(input: CreateThreadInput): ThreadSummary {
    this.raw
      .prepare(
        `INSERT INTO threads (
          cloud_thread_id, runner_id, project_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(cloud_thread_id) DO UPDATE SET
          runner_id = excluded.runner_id,
          project_id = excluded.project_id,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.cloudThreadId,
        input.runnerId,
        input.projectId,
        input.status,
        input.createdAt,
        input.createdAt,
      );
    const thread = this.getThread(input.cloudThreadId);
    if (!thread) {
      throw new Error(`Failed to create thread ${input.cloudThreadId}.`);
    }
    return thread;
  }

  updateThreadStatus(input: UpdateThreadStatusInput): ThreadSummary | null {
    const current = this.getThread(input.cloudThreadId);
    if (!current) return null;
    this.raw
      .prepare(
        `UPDATE threads
         SET status = ?,
             provider_thread_id = COALESCE(?, provider_thread_id),
             active_turn_id = ?,
             last_event_sequence = COALESCE(?, last_event_sequence),
             updated_at = ?
         WHERE cloud_thread_id = ?`,
      )
      .run(
        input.status,
        input.providerThreadId ?? null,
        input.activeTurnId ?? null,
        input.lastEventSequence ?? null,
        input.updatedAt,
        input.cloudThreadId,
      );
    return this.getThread(input.cloudThreadId);
  }

  updateThreadLastEvent(input: {
    readonly cloudThreadId: string;
    readonly sequence: number;
    readonly updatedAt: string;
  }): void {
    this.raw
      .prepare(
        `UPDATE threads
         SET last_event_sequence = ?, updated_at = ?
         WHERE cloud_thread_id = ?`,
      )
      .run(input.sequence, input.updatedAt, input.cloudThreadId);
  }

  getThread(cloudThreadId: string): ThreadSummary | null {
    const row = this.raw
      .prepare(`SELECT * FROM threads WHERE cloud_thread_id = ?`)
      .get(cloudThreadId);
    return row ? toThreadSummary(row) : null;
  }

  listThreads(input: ListThreadsInput = {}): ThreadSummary[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.runnerId) {
      clauses.push("runner_id = ?");
      params.push(input.runnerId);
    }
    if (input.projectId) {
      clauses.push("project_id = ?");
      params.push(input.projectId);
    }
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    params.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.raw
      .prepare(
        `SELECT * FROM threads
         ${where}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(...params);
    return rows.map(toThreadSummary);
  }

  createRunnerCommand(input: CreateRunnerCommandInput): void {
    this.raw
      .prepare(
        `INSERT INTO runner_commands (
          command_id, runner_id, cloud_thread_id, command_type, status, payload_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.commandId,
        input.runnerId,
        input.cloudThreadId,
        input.commandType,
        input.status,
        json(input.payload),
        input.createdAt,
        input.createdAt,
      );
  }

  updateRunnerCommandStatus(input: {
    readonly commandId: string;
    readonly status: string;
    readonly updatedAt: string;
  }): void {
    this.raw
      .prepare(
        `UPDATE runner_commands
         SET status = ?, updated_at = ?
         WHERE command_id = ?`,
      )
      .run(input.status, input.updatedAt, input.commandId);
  }

  getRunnerCommand(commandId: string): RunnerCommandRow | null {
    const row = this.raw
      .prepare(`SELECT * FROM runner_commands WHERE command_id = ?`)
      .get(commandId);
    return row ? toRunnerCommandRow(row) : null;
  }

  upsertPendingApproval(input: UpsertPendingApprovalInput): PendingApprovalSummary {
    this.raw
      .prepare(
        `INSERT INTO pending_approvals (
          approval_id, runner_id, cloud_thread_id, project_id, approval_type, status,
          payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(approval_id) DO UPDATE SET
          status = excluded.status,
          payload_json = excluded.payload_json`,
      )
      .run(
        input.approvalId,
        input.runnerId,
        input.cloudThreadId,
        input.projectId,
        input.approvalType,
        input.status,
        json(input.payload),
        input.createdAt,
      );
    const approval = this.getApproval(input.approvalId);
    if (!approval) {
      throw new Error(`Failed to upsert approval ${input.approvalId}.`);
    }
    return approval;
  }

  resolvePendingApproval(input: ResolvePendingApprovalInput): PendingApprovalSummary | null {
    this.raw
      .prepare(
        `UPDATE pending_approvals
         SET status = ?, decision = ?, resolved_at = ?
         WHERE approval_id = ?`,
      )
      .run(input.status, input.decision, input.resolvedAt, input.approvalId);
    return this.getApproval(input.approvalId);
  }

  getApproval(approvalId: string): PendingApprovalSummary | null {
    const row = this.raw
      .prepare(`SELECT * FROM pending_approvals WHERE approval_id = ?`)
      .get(approvalId);
    return row ? toPendingApprovalSummary(row) : null;
  }

  listApprovals(input: {
    readonly status?: ApprovalStatus;
    readonly threadId?: string;
  } = {}): PendingApprovalSummary[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.status) {
      clauses.push("status = ?");
      params.push(input.status);
    }
    if (input.threadId) {
      clauses.push("cloud_thread_id = ?");
      params.push(input.threadId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.raw
      .prepare(
        `SELECT * FROM pending_approvals
         ${where}
         ORDER BY created_at DESC
         LIMIT 200`,
      )
      .all(...params);
    return rows.map(toPendingApprovalSummary);
  }

  createUpload(input: CreateUploadInput): HandoffUploadRow {
    this.raw
      .prepare(
        `INSERT INTO handoff_uploads (
          upload_id, runner_id, project_id, actor_device_id, status, file_path,
          total_bytes, expected_sha256, manifest_json, handoff_prompt, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.uploadId,
        input.runnerId,
        input.projectId,
        input.actorDeviceId,
        input.status,
        input.filePath,
        input.totalBytes,
        input.expectedSha256 ?? null,
        json(input.manifest),
        input.handoffPrompt ?? null,
        input.createdAt,
      );
    const upload = this.getUpload(input.uploadId);
    if (!upload) {
      throw new Error(`Failed to create upload ${input.uploadId}.`);
    }
    return upload;
  }

  getUpload(uploadId: string): HandoffUploadRow | null {
    const row = this.raw
      .prepare(`SELECT * FROM handoff_uploads WHERE upload_id = ?`)
      .get(uploadId);
    return row ? toHandoffUploadRow(row) : null;
  }

  addUploadBytes(input: { readonly uploadId: string; readonly bytes: number }): HandoffUploadRow | null {
    this.raw
      .prepare(
        `UPDATE handoff_uploads
         SET received_bytes = received_bytes + ?
         WHERE upload_id = ?`,
      )
      .run(input.bytes, input.uploadId);
    return this.getUpload(input.uploadId);
  }

  markUploadCompleted(input: {
    readonly uploadId: string;
    readonly actualSha256: string;
    readonly handoffPrompt: string;
    readonly commandId: string;
    readonly completedAt: string;
  }): HandoffUploadRow | null {
    this.raw
      .prepare(
        `UPDATE handoff_uploads
         SET status = 'complete',
             actual_sha256 = ?,
             handoff_prompt = ?,
             command_id = ?,
             completed_at = ?
         WHERE upload_id = ?`,
      )
      .run(
        input.actualSha256,
        input.handoffPrompt,
        input.commandId,
        input.completedAt,
        input.uploadId,
      );
    return this.getUpload(input.uploadId);
  }

  markUploadUnpacked(input: {
    readonly uploadId: string;
    readonly cloudThreadId: string;
    readonly unpackedAt: string;
  }): HandoffUploadRow | null {
    this.raw
      .prepare(
        `UPDATE handoff_uploads
         SET status = 'unpacked',
             cloud_thread_id = ?,
             unpacked_at = ?
         WHERE upload_id = ?`,
      )
      .run(input.cloudThreadId, input.unpackedAt, input.uploadId);
    return this.getUpload(input.uploadId);
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
