/**
 * Schwab Trader API OAuth tokens (Individual).
 * Tokens live at ~/.tradedash/schwab-tokens.json (from scripts/schwab-oauth.mjs).
 * Access ~30m; refresh ~7d then full browser re-auth required.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "./logger.js";

const TOKEN_PATH = join(homedir(), ".tradedash", "schwab-tokens.json");
/** Refresh access token this many ms before expiry. */
const ACCESS_SKEW_MS = 90_000;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A73: persistent UI warning when refresh token has ≤ this many days left. */
export const SCHWAB_REAUTH_WARN_DAYS = 2;

export interface SchwabTokenFile {
  obtainedAt: string;
  expiresIn?: number;
  access_token: string;
  refresh_token: string;
  callback?: string;
  /** Wall-clock when access_token expires (set on refresh). */
  accessExpiresAt?: string;
  lastRefreshAt?: string;
  lastError?: string | null;
}

let memory: SchwabTokenFile | null = null;
/** mtime of the file `memory` came from — re-read when schwab-oauth.mjs writes new tokens. */
let memoryMtimeMs = 0;
let refreshInFlight: Promise<string | null> | null = null;

function clientId(): string | undefined {
  return process.env["SCHWAB_CLIENT_ID"] || process.env["SCHWAB_APP_KEY"];
}
function clientSecret(): string | undefined {
  return process.env["SCHWAB_SECRET"] || process.env["SCHWAB_APP_SECRET"];
}

export function schwabCredentialsConfigured(): boolean {
  return Boolean(clientId() && clientSecret());
}

export function getSchwabTokenPath(): string {
  return TOKEN_PATH;
}

function fileMtimeMs(): number {
  try {
    return statSync(TOKEN_PATH).mtimeMs;
  } catch {
    return 0;
  }
}

function loadFile(): SchwabTokenFile | null {
  const mtime = fileMtimeMs();
  if (memory && mtime === memoryMtimeMs) return memory;
  try {
    if (!existsSync(TOKEN_PATH)) return null;
    memory = JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as SchwabTokenFile;
    memoryMtimeMs = mtime;
    return memory;
  } catch (err) {
    logger.warn({ err: String(err) }, "schwab-auth: failed to read token file");
    return null;
  }
}

function saveFile(t: SchwabTokenFile): void {
  mkdirSync(join(homedir(), ".tradedash"), { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2), { mode: 0o600 });
  memory = t;
  memoryMtimeMs = fileMtimeMs();
}

/** Record a refresh failure without clobbering tokens a re-auth wrote meanwhile. */
function saveError(t: SchwabTokenFile, err: string): void {
  const disk = loadFile();
  if (disk && disk.refresh_token !== t.refresh_token) return;
  saveFile({ ...t, lastError: err });
}

/** Days until refresh token expires (7d from obtainedAt). Pure — used by status + tests. */
export function computeRefreshDaysLeft(obtainedAt: string, now = Date.now()): number | null {
  const anchor = Date.parse(obtainedAt);
  if (!Number.isFinite(anchor)) return null;
  return Math.max(0, (anchor + REFRESH_TTL_MS - now) / (24 * 60 * 60 * 1000));
}

function accessStillValid(t: SchwabTokenFile): boolean {
  if (!t.access_token) return false;
  if (t.accessExpiresAt) {
    return Date.parse(t.accessExpiresAt) - Date.now() > ACCESS_SKEW_MS;
  }
  // Legacy oauth script write: assume obtainedAt + expiresIn
  const obtained = Date.parse(t.obtainedAt);
  const ttl = (t.expiresIn ?? 1800) * 1000;
  if (!Number.isFinite(obtained)) return false;
  return obtained + ttl - Date.now() > ACCESS_SKEW_MS;
}

export type SchwabAuthWarning = "ok" | "warn" | "urgent" | "down";

export function getSchwabAuthStatus(): {
  configured: boolean;
  hasTokens: boolean;
  accessValid: boolean;
  refreshDaysLeft: number | null;
  /** ISO when the 7-day refresh token expires (obtainedAt + 7d). */
  refreshExpiresAt: string | null;
  /** ok | warn (≤2d) | urgent (≤1d) | down (expired / invalid_grant / unlinked). */
  warningLevel: SchwabAuthWarning;
  obtainedAt: string | null;
  lastError: string | null;
  tokenPath: string;
} {
  const configured = schwabCredentialsConfigured();
  const t = loadFile();
  if (!t?.refresh_token) {
    return {
      configured,
      hasTokens: false,
      accessValid: false,
      refreshDaysLeft: null,
      refreshExpiresAt: null,
      warningLevel: configured ? "down" : "down",
      obtainedAt: null,
      lastError: t?.lastError ?? null,
      tokenPath: TOKEN_PATH,
    };
  }
  // Anchor on obtainedAt (refresh-token issue / last rotation) — NOT lastRefreshAt.
  // Access-token refresh every ~30m must not reset the 7-day re-auth clock.
  const refreshDaysLeft = computeRefreshDaysLeft(t.obtainedAt);
  const anchor = Date.parse(t.obtainedAt);
  const refreshExpiresAt = Number.isFinite(anchor)
    ? new Date(anchor + REFRESH_TTL_MS).toISOString()
    : null;
  const invalidGrant = /invalid_grant/i.test(t.lastError ?? "");
  let warningLevel: SchwabAuthWarning = "ok";
  if (invalidGrant || (refreshDaysLeft != null && refreshDaysLeft <= 0) || (t.lastError && !accessStillValid(t))) {
    warningLevel = "down";
  } else if (refreshDaysLeft != null && refreshDaysLeft <= 1) {
    warningLevel = "urgent";
  } else if (refreshDaysLeft != null && refreshDaysLeft <= SCHWAB_REAUTH_WARN_DAYS) {
    warningLevel = "warn";
  }
  return {
    configured,
    hasTokens: true,
    accessValid: accessStillValid(t),
    refreshDaysLeft,
    refreshExpiresAt,
    warningLevel,
    obtainedAt: t.obtainedAt,
    lastError: t.lastError ?? null,
    tokenPath: TOKEN_PATH,
  };
}

/** Persist tokens from authorization-code exchange (UI oauth or schwab-oauth.mjs). */
export function saveSchwabOAuthTokens(tokens: {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  callback?: string;
}): void {
  const expiresIn = tokens.expires_in ?? 1800;
  saveFile({
    obtainedAt: new Date().toISOString(),
    expiresIn,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    callback: tokens.callback,
    accessExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    lastRefreshAt: new Date().toISOString(),
    lastError: null,
  });
}

export function getSchwabOAuthClient(): { clientId: string; clientSecret: string; callback: string } | null {
  const id = clientId();
  const secret = clientSecret();
  if (!id || !secret) return null;
  return {
    clientId: id,
    clientSecret: secret,
    callback: process.env["SCHWAB_CALLBACK_URL"] || "https://127.0.0.1:8182",
  };
}

async function refreshAccessToken(t: SchwabTokenFile): Promise<string | null> {
  const id = clientId();
  const secret = clientSecret();
  if (!id || !secret) {
    logger.warn("schwab-auth: missing SCHWAB_CLIENT_ID / SCHWAB_SECRET");
    return null;
  }
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
  });
  try {
    const res = await fetch("https://api.schwabapi.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !json.access_token) {
      const err = json.error_description || json.error || `HTTP ${res.status}`;
      saveError(t, String(err));
      logger.warn({ err, status: res.status }, "schwab-auth: refresh failed — re-run scripts/schwab-oauth.mjs");
      return null;
    }
    const expiresIn = json.expires_in ?? 1800;
    const next: SchwabTokenFile = {
      ...t,
      access_token: json.access_token,
      refresh_token: json.refresh_token || t.refresh_token,
      expiresIn,
      accessExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      lastRefreshAt: new Date().toISOString(),
      lastError: null,
    };
    // If Schwab rotated refresh_token, reset the 7-day clock anchor
    if (json.refresh_token && json.refresh_token !== t.refresh_token) {
      next.obtainedAt = next.lastRefreshAt!;
    }
    saveFile(next);
    return next.access_token;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    saveError(t, msg);
    logger.warn({ err: msg }, "schwab-auth: refresh threw");
    return null;
  }
}

/** Force next getSchwabAccessToken() to refresh (e.g. after HTTP 401). */
export function invalidateSchwabAccessToken(): void {
  const t = loadFile();
  if (!t?.access_token) return;
  saveFile({ ...t, accessExpiresAt: new Date(0).toISOString() });
}

/** Bearer access token, or null if unavailable (caller should Yahoo-fallback). */
export async function getSchwabAccessToken(): Promise<string | null> {
  if (!schwabCredentialsConfigured()) return null;
  const t = loadFile();
  if (!t?.refresh_token) return null;
  if (accessStillValid(t)) return t.access_token;

  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken(t).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}
