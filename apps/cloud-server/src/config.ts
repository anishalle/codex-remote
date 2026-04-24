import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface CloudServerConfig {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly bootstrapToken?: string;
  readonly tokenHashSecret: string;
  readonly sessionTtlSeconds: number;
  readonly pairingTtlSeconds: number;
  readonly maxWebSocketPayloadBytes: number;
  readonly allowedOrigins: readonly string[];
  readonly secureCookies: boolean;
  readonly uploadDir: string;
}

function readIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readCsvEnv(name: string): readonly string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function loadConfigFromEnv(): CloudServerConfig {
  const dbPath = process.env.CLOUD_CODEX_DB_PATH?.trim() || "./data/cloudcodex.sqlite";
  const tokenHashSecret = process.env.CLOUD_CODEX_TOKEN_HASH_SECRET?.trim();
  if (!tokenHashSecret) {
    throw new Error("CLOUD_CODEX_TOKEN_HASH_SECRET must be set.");
  }

  return {
    host: process.env.CLOUD_CODEX_HOST?.trim() || "127.0.0.1",
    port: readIntegerEnv("CLOUD_CODEX_PORT", 8787),
    dbPath: resolve(dbPath),
    bootstrapToken: process.env.CLOUD_CODEX_BOOTSTRAP_TOKEN?.trim() || undefined,
    tokenHashSecret,
    sessionTtlSeconds: readIntegerEnv("CLOUD_CODEX_SESSION_TTL_SECONDS", 60 * 60 * 24 * 30),
    pairingTtlSeconds: readIntegerEnv("CLOUD_CODEX_PAIRING_TTL_SECONDS", 60 * 5),
    maxWebSocketPayloadBytes: readIntegerEnv("CLOUD_CODEX_WS_MAX_PAYLOAD_BYTES", 64 * 1024),
    allowedOrigins: readCsvEnv("CLOUD_CODEX_ALLOWED_ORIGINS"),
    secureCookies: process.env.CLOUD_CODEX_SECURE_COOKIES === "1",
    uploadDir: resolve(
      process.env.CLOUD_CODEX_UPLOAD_DIR?.trim() ||
        (dbPath === ":memory:" ? mkdtempSync(join(tmpdir(), "cloudcodex-uploads-")) : join(dirname(dbPath), "uploads")),
    ),
  };
}

export function makeTestConfig(overrides: Partial<CloudServerConfig> = {}): CloudServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    bootstrapToken: "test-bootstrap-token",
    tokenHashSecret: "test-token-hash-secret",
    sessionTtlSeconds: 60 * 60,
    pairingTtlSeconds: 60,
    maxWebSocketPayloadBytes: 64 * 1024,
    allowedOrigins: [],
    secureCookies: false,
    uploadDir: mkdtempSync(join(tmpdir(), "cloudcodex-test-uploads-")),
    ...overrides,
  };
}
