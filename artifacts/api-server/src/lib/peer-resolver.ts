import YahooFinanceClass from "yahoo-finance2";
import { eq, and, ne, inArray } from "drizzle-orm";
import { db, tickerRegistry, type TickerRegistryRow } from "@workspace/db";
import { TTLCache } from "./ttl-cache.js";
import { checkFMPBudget, recordFMPCalls } from "./fundamentals-db.js";
import { logger } from "./logger.js";

const yahooFinance = new YahooFinanceClass();

export const peersCache = new TTLCache<PeersPayload>(24 * 60 * 60 * 1000, "peer-map");
const profileCache = new TTLCache<{ sector: string | null; industry: string | null; name: string | null }>(
  24 * 60 * 60 * 1000,
  "peer-profile",
);

export interface PeersPayload {
  ticker: string;
  sector: string | null;
  industry: string | null;
  peers: string[];
}

function uniqUpper(tickers: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tickers) {
    const u = t.trim().toUpperCase();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

async function readRegistryRow(ticker: string): Promise<TickerRegistryRow | null> {
  const rows = await db.select().from(tickerRegistry).where(eq(tickerRegistry.ticker, ticker)).limit(1);
  return rows[0] ?? null;
}

async function queryIndustryPeers(industry: string, exclude: string, limit = 15): Promise<string[]> {
  const rows = await db
    .select({ ticker: tickerRegistry.ticker })
    .from(tickerRegistry)
    .where(and(eq(tickerRegistry.industryGroup, industry), ne(tickerRegistry.ticker, exclude)))
    .limit(limit);
  return rows.map(r => r.ticker.toUpperCase());
}

async function querySectorPeers(sector: string, exclude: string, limit = 15): Promise<string[]> {
  const rows = await db
    .select({ ticker: tickerRegistry.ticker })
    .from(tickerRegistry)
    .where(and(eq(tickerRegistry.sector, sector), ne(tickerRegistry.ticker, exclude)))
    .limit(limit);
  return rows.map(r => r.ticker.toUpperCase());
}

async function fetchProfileMetadata(ticker: string): Promise<{ sector: string | null; industry: string | null; name: string | null }> {
  const cached = profileCache.get(ticker);
  if (cached) return cached;

  try {
    const summary = await yahooFinance.quoteSummary(ticker, {
      modules: ["assetProfile"] as any,
    }, { validateResult: false });
    const ap = (summary as any).assetProfile ?? {};
    const meta = {
      sector:   (ap.sector as string) ?? null,
      industry: (ap.industry as string) ?? null,
      name:     (ap.longName as string) ?? (ap.shortName as string) ?? null,
    };
    profileCache.set(ticker, meta);
    return meta;
  } catch (err) {
    logger.warn({ ticker, err: String(err) }, "peer-resolver: profile fetch failed");
    return { sector: null, industry: null, name: null };
  }
}

async function upsertRegistryMeta(
  ticker: string,
  meta: { sector?: string | null; industry?: string | null; name?: string | null; peerTickers?: string[] },
): Promise<void> {
  const existing = await readRegistryRow(ticker);
  const values = {
    ticker,
    name:          meta.name ?? existing?.name ?? null,
    sector:        meta.sector ?? existing?.sector ?? null,
    industryGroup: meta.industry ?? existing?.industryGroup ?? null,
    peerTickers:   meta.peerTickers ?? existing?.peerTickers ?? [],
    isActive:      true,
  };
  await db.insert(tickerRegistry)
    .values(values)
    .onConflictDoUpdate({
      target: tickerRegistry.ticker,
      set: {
        name:          values.name,
        sector:        values.sector,
        industryGroup: values.industryGroup,
        peerTickers:   values.peerTickers,
        isActive:      true,
      },
    });
}

/** Bidirectional peer graph merge — peers rarely change, write once. */
export async function mergePeerLinks(subject: string, peers: string[]): Promise<void> {
  const s = subject.toUpperCase();
  const normalized = uniqUpper(peers).filter(p => p !== s);
  if (normalized.length === 0) return;

  const subjectRow = await readRegistryRow(s);
  const subjectPeers = uniqUpper([...(subjectRow?.peerTickers ?? []), ...normalized]);
  await upsertRegistryMeta(s, { peerTickers: subjectPeers });

  for (const p of normalized) {
    const peerRow = await readRegistryRow(p);
    const linked = uniqUpper([
      ...(peerRow?.peerTickers ?? []),
      s,
      ...normalized.filter(x => x !== p),
    ]);
    await upsertRegistryMeta(p, { peerTickers: linked });
  }
}

async function fetchFinnhubPeers(ticker: string): Promise<string[]> {
  const apiKey = process.env.FINNHUB_API_KEY ?? "";
  if (!apiKey) return [];
  try {
    const url = `https://finnhub.io/api/v1/stock/peers?symbol=${encodeURIComponent(ticker)}&token=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return uniqUpper((json as string[]).filter(p => p && p !== ticker));
  } catch (err) {
    logger.warn({ ticker, err: String(err) }, "peer-resolver: Finnhub peers failed");
    return [];
  }
}

async function fetchFMPStockPeers(ticker: string): Promise<string[]> {
  const apiKey = process.env.FMP_API_KEY ?? "";
  if (!apiKey) return [];

  const budget = await checkFMPBudget(1);
  if (!budget.allowed) {
    logger.warn({ ticker }, "peer-resolver: FMP budget exhausted, skipping stock-peers");
    return [];
  }

  try {
    const url = `https://financialmodelingprep.com/stable/stock-peers?symbol=${encodeURIComponent(ticker)}&apikey=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    await recordFMPCalls(1);
    if (!res.ok) return [];
    const json = await res.json() as Array<{ symbol?: string }>;
    if (!Array.isArray(json)) return [];
    return uniqUpper(json.map(r => r.symbol ?? "").filter(Boolean));
  } catch (err) {
    logger.warn({ ticker, err: String(err) }, "peer-resolver: FMP stock-peers failed");
    return [];
  }
}

async function collectPeersFromRegistry(reg: TickerRegistryRow | null, key: string): Promise<string[]> {
  let peers = uniqUpper(reg?.peerTickers ?? []);

  if (peers.length < 5 && reg?.industryGroup) {
    peers = uniqUpper([...peers, ...await queryIndustryPeers(reg.industryGroup, key)]);
  }
  if (peers.length < 5 && reg?.sector) {
    peers = uniqUpper([...peers, ...await querySectorPeers(reg.sector, key)]);
  }
  return peers.filter(p => p !== key);
}

/** DB-first peer resolution. At most one external fetch per ticker (profile + optional FMP peers). */
export async function resolvePeers(ticker: string): Promise<PeersPayload> {
  const key = ticker.toUpperCase();
  const cached = peersCache.get(key);
  if (cached) return cached;

  let reg = await readRegistryRow(key);
  let peers = await collectPeersFromRegistry(reg, key);

  if (peers.length < 5 && (!reg?.sector || !reg?.industryGroup)) {
    const profile = await fetchProfileMetadata(key);
    if (profile.sector || profile.industry) {
      await upsertRegistryMeta(key, {
        sector: profile.sector,
        industry: profile.industry,
        name: profile.name,
        peerTickers: reg?.peerTickers ?? [],
      });
      reg = await readRegistryRow(key);
      peers = await collectPeersFromRegistry(reg, key);
    }
  }

  if (peers.length < 5) {
    const finnhubPeers = await fetchFinnhubPeers(key);
    if (finnhubPeers.length > 0) {
      await mergePeerLinks(key, finnhubPeers);
      reg = await readRegistryRow(key);
      peers = await collectPeersFromRegistry(reg, key);
    }
  }

  if (peers.length < 5) {
    const fmpPeers = await fetchFMPStockPeers(key);
    if (fmpPeers.length > 0) {
      await mergePeerLinks(key, fmpPeers);
      reg = await readRegistryRow(key);
      peers = await collectPeersFromRegistry(reg, key);
    }
  }

  peers = peers.filter(p => p !== key).slice(0, 15);
  const payload: PeersPayload = {
    ticker: key,
    sector: reg?.sector ?? null,
    industry: reg?.industryGroup ?? null,
    peers,
  };
  peersCache.set(key, payload);
  return payload;
}
