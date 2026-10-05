/**
 * Schwab Trader API OAuth tokens (Individual).
 * Tokens live at ~/.tradedash/schwab-tokens.json (from scripts/schwab-oauth.mjs).
 * Access ~30m; refresh ~7d then full browser re-auth required.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "./logger.js";

const TOKEN_PATH = join(homedir(), ".tradedash", "schwab-tokens.json");
/** Refresh access token this many ms before expiry. */
const ACCESS_SKEW_MS = 90_000;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

function loadFile(): SchwabTokenFile | null {
  if (memory) return memory;
  try {
    if (!existsSync(TOKEN_PATH)) return null;
    memory = JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as SchwabTokenFile;
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

export function getSchwabAuthStatus(): {
  configured: boolean;
  hasTokens: boolean;
  accessValid: boolean;
  refreshDaysLeft: number | null;
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
      obtainedAt: null,
      lastError: t?.lastError ?? null,
      tokenPath: TOKEN_PATH,
    };
  }
  // Anchor on obtainedAt (refresh-token issue / last rotation) — NOT lastRefreshAt.
  // Access-token refresh every ~30m must not reset the 7-day re-auth clock.
  const refreshDaysLeft = computeRefreshDaysLeft(t.obtainedAt);
  return {
    configured,
    hasTokens: true,
    accessValid: accessStillValid(t),
    refreshDaysLeft,
    obtainedAt: t.obtainedAt,
    lastError: t.lastError ?? null,
    tokenPath: TOKEN_PATH,
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
      saveFile({ ...t, lastError: String(err) });
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
    saveFile({ ...t, lastError: msg });
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
