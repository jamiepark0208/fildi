/**
 * FMP free-tier symbol restriction cache (A84).
 * Non-mega-caps return "Premium Query Parameter" — skip for 30 days.
 * `scope` keys one endpoint (e.g. "earnings": TMO 402s there but not on fundamentals) — default = whole ticker.
 */
import { db, appConfig } from "@workspace/db";
import { eq } from "drizzle-orm";

const KEY = "fmp_restricted_tickers";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

type RestrictedMap = Record<string, string>; // ticker → ISO until

async function load(): Promise<RestrictedMap> {
  const rows = await db.select().from(appConfig).where(eq(appConfig.key, KEY)).limit(1);
  const v = rows[0]?.value;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as RestrictedMap) : {};
}

async function save(map: RestrictedMap): Promise<void> {
  const existing = await db.select().from(appConfig).where(eq(appConfig.key, KEY)).limit(1);
  if (existing.length === 0) {
    await db.insert(appConfig).values({ key: KEY, value: map });
  } else {
    await db.update(appConfig).set({ value: map, updatedAt: new Date() }).where(eq(appConfig.key, KEY));
  }
}

export async function isFmpRestricted(ticker: string, scope?: string): Promise<boolean> {
  const t = scope ? `${scope}:${ticker.toUpperCase()}` : ticker.toUpperCase();
  const map = await load();
  const until = map[t];
  if (!until) return false;
  if (Date.parse(until) <= Date.now()) {
    delete map[t];
    await save(map);
    return false;
  }
  return true;
}

export async function markFmpRestricted(ticker: string, scope?: string): Promise<void> {
  const t = scope ? `${scope}:${ticker.toUpperCase()}` : ticker.toUpperCase();
  const map = await load();
  map[t] = new Date(Date.now() + TTL_MS).toISOString();
  await save(map);
}

export function isFmpPremiumError(err: unknown): boolean {
  // fetchJsonWithRetry throws "FMP HTTP 402 for …" (body text not included) — 10-21: AAOI 402'd 21× in 2 days, never cached.
  return /Premium Query Parameter|FMP HTTP 402\b/i.test(String(err instanceof Error ? err.message : err));
}
