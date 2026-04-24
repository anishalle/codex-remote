import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { CloudServerConfig } from "./config.ts";
import type { CloudDatabase, VerifiedSessionRow } from "./db.ts";

export const SESSION_COOKIE_NAME = "cc_session";

export interface PairingTokenResult {
  readonly id: string;
  readonly pairingToken: string;
  readonly deviceKind: "runner" | "client" | "owner";
  readonly expiresAt: string;
}

export interface FinishPairingInput {
  readonly pairingToken: string;
  readonly deviceName: string;
  readonly deviceKind?: "runner" | "client" | "owner";
}

export interface SessionTokenResult {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceKind: "runner" | "client" | "owner";
  readonly sessionToken: string;
  readonly expiresAt: string;
}

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceKind: "runner" | "client" | "owner";
  readonly deviceName: string;
  readonly expiresAt: string;
}

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function secondsFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function normalizeBearer(raw: string | undefined): string | null {
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() || null;
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.split("=");
    const key = rawKey?.trim();
    if (key !== name) continue;
    const value = rawValue.join("=").trim();
    return value.length > 0 ? decodeURIComponent(value) : null;
  }
  return null;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function tokenHash(secret: string, token: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

function toSession(row: VerifiedSessionRow): AuthenticatedSession {
  return {
    sessionId: row.sessionId,
    deviceId: row.deviceId,
    deviceKind: row.deviceKind,
    deviceName: row.deviceName,
    expiresAt: row.expiresAt,
  };
}

export class AuthService {
  readonly db: CloudDatabase;
  readonly config: CloudServerConfig;

  constructor(input: { readonly db: CloudDatabase; readonly config: CloudServerConfig }) {
    this.db = input.db;
    this.config = input.config;
  }

  hashToken(token: string): string {
    return tokenHash(this.config.tokenHashSecret, token);
  }

  createPairingToken(input: {
    readonly deviceKind: "runner" | "client" | "owner";
    readonly label?: string;
    readonly ttlSeconds?: number;
    readonly createdByDeviceId?: string | null;
  }): PairingTokenResult {
    const pairingToken = randomToken("ccp");
    const createdAt = nowIso();
    const expiresAt = secondsFromNow(input.ttlSeconds ?? this.config.pairingTtlSeconds);
    const id = randomUUID();
    this.db.createPairingToken({
      id,
      tokenHash: this.hashToken(pairingToken),
      deviceKind: input.deviceKind,
      label: input.label?.trim() || null,
      createdAt,
      expiresAt,
      createdByDeviceId: input.createdByDeviceId ?? null,
    });
    this.db.appendAudit({
      actorKind: input.createdByDeviceId ? "device" : "bootstrap",
      actorDeviceId: input.createdByDeviceId ?? null,
      action: "pairing.token.created",
      targetKind: "pairing_token",
      targetId: id,
      ok: true,
      detail: {
        deviceKind: input.deviceKind,
        expiresAt,
      },
    });
    return {
      id,
      pairingToken,
      deviceKind: input.deviceKind,
      expiresAt,
    };
  }

  finishPairing(input: FinishPairingInput): SessionTokenResult {
    const normalizedToken = input.pairingToken.trim();
    if (!normalizedToken) {
      throw new AuthError("pairing_token_invalid", "Pairing token is required.");
    }
    const tokenRow = this.db.getPairingTokenByHash(this.hashToken(normalizedToken));
    if (!tokenRow) {
      this.auditPairingFailure("pairing.finish.failed", "unknown");
      throw new AuthError("pairing_token_invalid", "Invalid pairing token.");
    }
    if (tokenRow.revokedAt !== null || tokenRow.consumedAt !== null) {
      this.auditPairingFailure("pairing.finish.failed", "unavailable", tokenRow.id);
      throw new AuthError("pairing_token_unavailable", "Pairing token is no longer available.");
    }
    if (Date.parse(tokenRow.expiresAt) <= Date.now()) {
      this.auditPairingFailure("pairing.finish.failed", "expired", tokenRow.id);
      throw new AuthError("pairing_token_expired", "Pairing token expired.");
    }
    if (input.deviceKind && input.deviceKind !== tokenRow.deviceKind) {
      this.auditPairingFailure("pairing.finish.failed", "wrong_device_kind", tokenRow.id);
      throw new AuthError("pairing_device_kind_mismatch", "Pairing token is for another device kind.");
    }

    const deviceId = randomUUID();
    const createdAt = nowIso();
    const deviceName = input.deviceName.trim();
    if (!deviceName) {
      throw new AuthError("device_name_required", "Device name is required.", 400);
    }

    const session = this.issueSession({
      deviceId,
      deviceKind: tokenRow.deviceKind,
      deviceName,
      issuedAt: createdAt,
    });
    this.db.consumePairingToken({
      id: tokenRow.id,
      consumedAt: createdAt,
      consumedByDeviceId: deviceId,
    });
    this.db.appendAudit({
      actorKind: "anonymous",
      actorDeviceId: deviceId,
      action: "pairing.finish.succeeded",
      targetKind: "pairing_token",
      targetId: tokenRow.id,
      ok: true,
      detail: {
        deviceKind: tokenRow.deviceKind,
      },
    });
    return session;
  }

  issueSession(input: {
    readonly deviceId: string;
    readonly deviceKind: "runner" | "client" | "owner";
    readonly deviceName: string;
    readonly issuedAt?: string;
  }): SessionTokenResult {
    const issuedAt = input.issuedAt ?? nowIso();
    const expiresAt = secondsFromNow(this.config.sessionTtlSeconds);
    const sessionToken = randomToken("ccs");
    const sessionId = randomUUID();
    this.db.createDevice({
      deviceId: input.deviceId,
      deviceKind: input.deviceKind,
      name: input.deviceName,
      createdAt: issuedAt,
    });
    this.db.createSession({
      sessionId,
      deviceId: input.deviceId,
      tokenHash: this.hashToken(sessionToken),
      issuedAt,
      expiresAt,
      revokedAt: null,
    });
    this.db.appendAudit({
      actorKind: "system",
      actorDeviceId: input.deviceId,
      action: "session.issued",
      targetKind: "session",
      targetId: sessionId,
      ok: true,
      detail: {
        deviceKind: input.deviceKind,
        expiresAt,
      },
    });
    return {
      sessionId,
      deviceId: input.deviceId,
      deviceKind: input.deviceKind,
      sessionToken,
      expiresAt,
    };
  }

  verifySessionToken(token: string): AuthenticatedSession {
    const normalized = token.trim();
    if (!normalized) {
      throw new AuthError("session_token_required", "Session token is required.");
    }
    const row = this.db.getSessionByTokenHash(this.hashToken(normalized), nowIso());
    if (!row) {
      this.db.appendAudit({
        actorKind: "anonymous",
        action: "session.verify.failed",
        ok: false,
        detail: {
          reason: "invalid_or_expired",
        },
      });
      throw new AuthError("session_token_invalid", "Invalid session token.");
    }
    return toSession(row);
  }

  authenticateRequest(req: IncomingMessage): AuthenticatedSession {
    const bearerToken = normalizeBearer(req.headers.authorization);
    const cookieToken = parseCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    const token = bearerToken ?? cookieToken;
    if (!token) {
      throw new AuthError("auth_required", "Authentication required.");
    }
    return this.verifySessionToken(token);
  }

  authenticateBootstrapOrRequest(req: IncomingMessage): AuthenticatedSession | null {
    const bootstrap = req.headers["x-bootstrap-token"];
    if (typeof bootstrap === "string" && this.config.bootstrapToken) {
      if (safeEqual(bootstrap, this.config.bootstrapToken)) {
        return null;
      }
    }
    return this.authenticateRequest(req);
  }

  setSessionCookie(res: ServerResponse, token: string, expiresAt: string): void {
    const parts = [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Expires=${new Date(expiresAt).toUTCString()}`,
    ];
    if (this.config.secureCookies) {
      parts.push("Secure");
    }
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  private auditPairingFailure(action: string, reason: string, targetId?: string): void {
    this.db.appendAudit({
      actorKind: "anonymous",
      action,
      targetKind: targetId ? "pairing_token" : null,
      targetId: targetId ?? null,
      ok: false,
      detail: { reason },
    });
  }
}
