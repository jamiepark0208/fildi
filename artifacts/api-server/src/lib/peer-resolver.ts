import { yahooFinance } from "./yahoo-client.js";
import { eq, and, ne, inArray } from "drizzle-orm";
import { db, tickerRegistry, type TickerRegistryRow } from "@workspace/db";
import { TTLCache } from "./ttl-cache.js";
import { checkFMPBudget, recordFMPCalls } from "./fundamentals-db.js";
import { logger } from "./logger.js";
import { fetchJsonWithRetry } from "./http-client.js";


export const peersCache = new TTLCache<PeersPayload>(24 * 60 * 60 * 1000, "peer-map", 1000); // key = ticker
export const profileCache = new TTLCache<{ sector: string | null; industry: string | null; name: string | null }>(
  24 * 60 * 60 * 1000,
  "peer-profile",
  1000, // key = ticker
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
  try {
    // Failures throw out of getOrCompute, so they are not cached (same as before).
    return await profileCache.getOrCompute(ticker, async () => {
      const summary = await yahooFinance.quoteSummary(ticker, {
        modules: ["assetProfile"] as any,
      }, { validateResult: false });
      const { rememberYahooQuoteSummary } = await import("./vendor-raw.js");
      await rememberYahooQuoteSummary(ticker, "assetProfile", summary);
      const ap = (summary as any).assetProfile ?? {};
      return {
        sector:   (ap.sector as string) ?? null,
        industry: (ap.industry as string) ?? null,
        name:     (ap.longName as string) ?? (ap.shortName as string) ?? null,
      };
    });
  } catch (err) {
    logger.warn({ ticker, err: String(err) }, "peer-resolver: profile fetch failed");
    return { sector: null, industry: null, name: null };
  }
}

async function upsertRegistryMeta(
  ticker: string,
  meta: { sector?: string | null; industry?: string | null; name?: string | null; peerTickers?: string[] },
  existing?: TickerRegistryRow | null,
): Promise<void> {
  const row = existing ?? await readRegistryRow(ticker);
  const values = {
    ticker,
    name:          meta.name ?? row?.name ?? null,
    sector:        meta.sector ?? row?.sector ?? null,
    industryGroup: meta.industry ?? row?.industryGroup ?? null,
    peerTickers:   meta.peerTickers ?? row?.peerTickers ?? [],
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

  // Batch-fetch all rows in one query instead of one per ticker
  const allTickers = [s, ...normalized];
  const rows = await db.select().from(tickerRegistry).where(inArray(tickerRegistry.ticker, allTickers));
  const rowMap = new Map(rows.map(r => [r.ticker, r]));

  const subjectPeers = uniqUpper([...(rowMap.get(s)?.peerTickers ?? []), ...normalized]);
  await upsertRegistryMeta(s, { peerTickers: subjectPeers });

  for (const p of normalized) {
    const linked = uniqUpper([
      ...(rowMap.get(p)?.peerTickers ?? []),
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
    const json = await fetchJsonWithRetry(url, { provider: "Finnhub", maxRetries: 1, timeoutMs: 10_000 });
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
    // No retries: each attempt spends daily FMP budget, and this is a best-effort peer source.
    // Recorded up front so a timeout still counts against the budget (conservative).
    await recordFMPCalls(1);
    const json = await fetchJsonWithRetry<Array<{ symbol?: string }>>(url, { provider: "FMP", maxRetries: 0, timeoutMs: 12_000 });
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
  // Concurrent views of the same ticker share one resolution (Finnhub/FMP/Yahoo calls).
  return peersCache.getOrCompute(key, () => computePeers(key));
}

async function computePeers(key: string): Promise<PeersPayload> {

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
      }, reg);
      // Update in-memory instead of re-reading
      reg = {
        ticker:             key,
        isActive:           true,
        fetchFundamentals:  false,
        addedAt:            reg?.addedAt ?? new Date(),
        indexMemberships:   reg?.indexMemberships ?? null,
        primaryPeerGroupId: reg?.primaryPeerGroupId ?? null,
        peerTickers:        reg?.peerTickers ?? null,
        sector:             profile.sector   ?? reg?.sector        ?? null,
        industryGroup:      profile.industry ?? reg?.industryGroup ?? null,
        name:               profile.name     ?? reg?.name          ?? null,
      };
      peers = await collectPeersFromRegistry(reg, key);
    }
  }

  if (peers.length < 5) {
    const finnhubPeers = await fetchFinnhubPeers(key);
    if (finnhubPeers.length > 0) {
      await mergePeerLinks(key, finnhubPeers);
      // Update peerTickers in-memory — mergePeerLinks wrote subject's merged list to DB
      reg = {
        ticker:             key,
        isActive:           reg?.isActive           ?? true,
        fetchFundamentals:  reg?.fetchFundamentals  ?? false,
        addedAt:            reg?.addedAt            ?? new Date(),
        indexMemberships:   reg?.indexMemberships   ?? null,
        primaryPeerGroupId: reg?.primaryPeerGroupId ?? null,
        name:               reg?.name               ?? null,
        sector:             reg?.sector             ?? null,
        industryGroup:      reg?.industryGroup      ?? null,
        peerTickers:        uniqUpper([...(reg?.peerTickers ?? []), ...finnhubPeers]),
      };
      peers = await collectPeersFromRegistry(reg, key);
    }
  }

  if (peers.length < 5) {
    const fmpPeers = await fetchFMPStockPeers(key);
    if (fmpPeers.length > 0) {
      await mergePeerLinks(key, fmpPeers);
      reg = {
        ticker:             key,
        isActive:           reg?.isActive           ?? true,
        fetchFundamentals:  reg?.fetchFundamentals  ?? false,
        addedAt:            reg?.addedAt            ?? new Date(),
        indexMemberships:   reg?.indexMemberships   ?? null,
        primaryPeerGroupId: reg?.primaryPeerGroupId ?? null,
        name:               reg?.name               ?? null,
        sector:             reg?.sector             ?? null,
        industryGroup:      reg?.industryGroup      ?? null,
        peerTickers:        uniqUpper([...(reg?.peerTickers ?? []), ...fmpPeers]),
      };
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
  return payload;
}
