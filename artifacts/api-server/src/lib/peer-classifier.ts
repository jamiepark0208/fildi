import { eq, inArray, count, desc, isNull, and, isNotNull, ne, sql } from "drizzle-orm";
import { db, tickerRegistry, peerGroupMembers, peerGroups, unmappedTickers, peerGroupOverrides } from "@workspace/db";
import { resolvePeers } from "./peer-resolver.js";
import { logger } from "./logger.js";
import { TTLCache } from "./ttl-cache.js";
import { isExcludedEtf } from "./etf-exclusions.js";

export type PeerGroupClassification = {
  groupId: string;
  confidence: "override" | "mapped" | "auto" | "unmapped";
  metricExclusions?: string[];
};

// ── Keyword map: Yahoo assetProfile sector+industry → peer group id ───────────
// Keys are lowercased substrings matched against "sector|industry" combined string.
const KEYWORD_MAP: Array<{ keywords: string[]; groupId: string }> = [
  // Technology
  { keywords: ["semiconductor equipment"],              groupId: "technology.semiconductors_equipment_eda" },
  { keywords: ["semiconductor"],                        groupId: "technology.semiconductors_design" },
  { keywords: ["software"],                             groupId: "technology.enterprise_software_cloud" },
  { keywords: ["information technology services"],      groupId: "technology.enterprise_software_cloud" },
  { keywords: ["consumer electronics"],                 groupId: "technology.big_tech_platforms" },
  { keywords: ["computer hardware", "electronic components", "communication equipment", "networking"], groupId: "technology.it_hardware_networking" },
  { keywords: ["quantum"],                              groupId: "speculative_thematic.quantum_computing" },
  // Communication Services
  { keywords: ["internet content", "internet retail", "entertainment"],  groupId: "technology.consumer_internet_digital_media" },
  { keywords: ["telecom"],                              groupId: "telecom.telecommunications" },
  { keywords: ["broadcasting", "media"],                groupId: "technology.consumer_internet_digital_media" },
  // Financial Services
  // A160: large + regional → financials.banks
  { keywords: ["banks—diversified", "banks-diversified", "diversified bank", "banks—regional", "banks-regional", "regional bank", "banks"], groupId: "financials.banks" },
  { keywords: ["asset management", "capital markets", "investment management"], groupId: "financials.asset_management_alt_finance" },
  { keywords: ["credit services", "financial data", "stock exchange"],         groupId: "financials.payment_networks_credit" },
  { keywords: ["insurance"],                            groupId: "financials.insurance" },
  // Healthcare
  { keywords: ["biotechnology"],                        groupId: "healthcare.large_biotech" },
  { keywords: ["drug manufacturers", "pharmaceuticals"], groupId: "healthcare.large_pharma" },
  { keywords: ["healthcare plans", "managed care"],     groupId: "healthcare.health_insurance_managed_care" },
  { keywords: ["medical devices", "medical instruments", "diagnostics"], groupId: "healthcare.medical_devices_equipment" },
  // Consumer Cyclical
  { keywords: ["auto manufacturers", "auto & truck"],   groupId: "consumer_discretionary.autos_evs" },
  { keywords: ["home improvement retail"],              groupId: "consumer_discretionary.retail_home_general" },
  { keywords: ["discount stores", "specialty retail"],  groupId: "consumer_discretionary.retail_home_general" },
  { keywords: ["restaurants"],                          groupId: "consumer_discretionary.restaurants_food_service" },
  { keywords: ["airlines", "travel services", "hotels & motels", "gambling", "resorts & casinos"], groupId: "consumer_discretionary.travel_leisure_hospitality" },
  { keywords: ["apparel", "footwear", "luxury"],        groupId: "consumer_discretionary.apparel_luxury" },
  { keywords: ["real estate services"],                 groupId: "consumer_discretionary.real_estate_platforms" },
  // Consumer Defensive
  { keywords: ["grocery", "farm products"],             groupId: "consumer_staples.food_grocery_agriculture" },
  { keywords: ["beverages", "packaged foods", "household & personal", "tobacco"], groupId: "consumer_staples.packaged_goods_beverages" },
  // Industrials
  { keywords: ["aerospace & defense"],                  groupId: "industrials.aerospace_defense" },
  // A160: waste → industrial conglomerates
  { keywords: ["waste management"],                     groupId: "industrials.industrial_conglomerates_machinery" },
  { keywords: ["railroads", "trucking", "air freight", "freight & logistics"], groupId: "industrials.transportation_logistics" },
  { keywords: ["staffing", "consulting", "financial exchanges", "research & consulting"], groupId: "industrials.professional_services" },
  { keywords: ["specialty industrial", "farm & heavy construction", "electrical equipment", "industrial machinery"], groupId: "industrials.industrial_conglomerates_machinery" },
  // Energy
  { keywords: ["oil & gas midstream"],                  groupId: "energy.midstream_pipelines" },
  { keywords: ["oil & gas equipment", "oilfield"],      groupId: "energy.oilfield_services" },
  { keywords: ["oil & gas", "integrated oil"],          groupId: "energy.integrated_oil_gas" },
  { keywords: ["solar", "renewable", "clean energy"],   groupId: "energy.clean_energy_renewables" },
  // Materials
  { keywords: ["gold", "silver", "precious metals"],    groupId: "materials.precious_metals_mining" },
  { keywords: ["copper", "aluminum", "base metals", "industrial metals", "other industrial metals", "uranium", "rare earth", "mining"], groupId: "materials.base_metals_mining" },
  { keywords: ["steel"],                                groupId: "materials.steel_industrial_metals" },
  { keywords: ["chemicals", "agricultural chemicals"],  groupId: "materials.chemicals" },
  { keywords: ["basic materials"],                      groupId: "materials.base_metals_mining" },
  // Real Estate
  { keywords: ["reit—specialty", "reit-specialty", "data center reit", "tower"],  groupId: "real_estate.reits_data_center_tower" },
  { keywords: ["reit"],                                 groupId: "real_estate.reits_diversified" },
  // Utilities
  { keywords: ["utilities—regulated electric", "regulated electric"],   groupId: "utilities.electric_utilities" },
  { keywords: ["utilities—regulated water", "utilities—regulated gas", "utilities—diversified", "multi-utilities"], groupId: "utilities.water_gas_multi_utilities" },
  { keywords: ["utilities—independent power"],          groupId: "energy.clean_energy_renewables" },
];

function keywordMatch(sector: string | null, industry: string | null): string | null {
  const haystack = `${sector ?? ""} | ${industry ?? ""}`.toLowerCase();
  for (const { keywords, groupId } of KEYWORD_MAP) {
    if (keywords.some(kw => haystack.includes(kw.toLowerCase()))) {
      return groupId;
    }
  }
  return null;
}

/** Public: sector/industry → peer group suggestion (no DB). Used by peer-health-check. */
export function suggestGroupFromSectorIndustry(
  sector: string | null,
  industry: string | null,
): string | null {
  return keywordMatch(sector, industry);
}

async function upsertPrimaryGroup(ticker: string, groupId: string): Promise<void> {
  await db.insert(tickerRegistry)
    .values({ ticker, primaryPeerGroupId: groupId })
    .onConflictDoUpdate({
      target: tickerRegistry.ticker,
      set: { primaryPeerGroupId: groupId },
    });
  // Keep the curated roster in sync with scoring assignment. Without this, auto-classified
  // tickers get a primary_peer_group_id but never appear in peer_group_members — so competitors /
  // PeerGroupEditor / getTaxonomyPeers silently omit them from the sector roster.
  await ensureGroupMembership(ticker, groupId, "auto");
}

/** Upsert an active roster row. Soft-deleted rows are revived. */
async function ensureGroupMembership(
  ticker: string,
  groupId: string,
  source: "taxonomy" | "manual" | "auto",
): Promise<void> {
  if (!groupId || groupId === "__global__") return;
  await db.insert(peerGroupMembers)
    .values({ groupId, ticker, source, removedAt: null })
    .onConflictDoUpdate({
      target: [peerGroupMembers.groupId, peerGroupMembers.ticker],
      set: { removedAt: null, source },
    });
}

/**
 * A147: a ticker may only be active in one peer group (peer medians otherwise double-count).
 * Soft-remove every other active membership for this ticker.
 */
export async function soleActiveMembership(
  ticker: string,
  groupId: string,
  source: "taxonomy" | "manual" | "auto",
): Promise<number> {
  const key = ticker.toUpperCase();
  if (!groupId || groupId === "__global__") return 0;
  await ensureGroupMembership(key, groupId, source);
  const removed = await db.update(peerGroupMembers)
    .set({ removedAt: new Date() })
    .where(and(
      eq(peerGroupMembers.ticker, key),
      isNull(peerGroupMembers.removedAt),
      ne(peerGroupMembers.groupId, groupId),
    ))
    .returning({ groupId: peerGroupMembers.groupId });
  return removed.length;
}

/**
 * A147 one-shot: override tickers must not keep a stale auto membership in the old group.
 * Seed duals (NVDA in big-tech + semis, etc.) are left alone — confirm with Jamie if those should sole too.
 */
export async function cleanupOverrideDualMemberships(): Promise<{
  fixed: number;
  overrideTickers: string[];
  dualsLeft: number;
}> {
  const overrides = await db.select({
    ticker: peerGroupOverrides.ticker,
    groupId: peerGroupOverrides.groupId,
  }).from(peerGroupOverrides);
  let fixed = 0;
  const overrideTickers: string[] = [];
  for (const o of overrides) {
    const n = await soleActiveMembership(o.ticker, o.groupId, "manual");
    if (n > 0) overrideTickers.push(o.ticker);
    fixed += n;
  }
  const left = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM (
      SELECT ticker FROM peer_group_members WHERE removed_at IS NULL
      GROUP BY ticker HAVING COUNT(*) > 1
    ) d`);
  const row = Array.isArray(left) ? left[0] : (left as { rows?: { n: string }[] }).rows?.[0];
  const dualsLeft = Number(row?.n ?? 0);
  return { fixed, overrideTickers, dualsLeft };
}

async function recordUnmapped(ticker: string): Promise<void> {
  await db.insert(unmappedTickers)
    .values({ ticker })
    .onConflictDoNothing();
}

async function fetchMetricExclusions(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ metricExclusions: peerGroups.metricExclusions })
    .from(peerGroups)
    .where(eq(peerGroups.id, groupId))
    .limit(1);
  return rows[0]?.metricExclusions ?? [];
}

export interface TaxonomyPeers {
  groupId: string;
  groupName: string | null;
  confidence: PeerGroupClassification["confidence"];
  peers: string[];
}

/** Peer group members for a ticker's classified taxonomy group (peer_groups/peer_group_members tables).
 *  Returns null when the ticker can't be classified (confidence "unmapped"). */
export async function getTaxonomyPeers(ticker: string, limit = 15): Promise<TaxonomyPeers | null> {
  const key = ticker.toUpperCase();
  const classification = await classifyTicker(key);
  if (classification.confidence === "unmapped") return null;

  const [groupRow, memberRows] = await Promise.all([
    db.select({ name: peerGroups.name }).from(peerGroups).where(eq(peerGroups.id, classification.groupId)).limit(1),
    db.select({ ticker: peerGroupMembers.ticker }).from(peerGroupMembers)
      .where(and(eq(peerGroupMembers.groupId, classification.groupId), isNull(peerGroupMembers.removedAt))),
  ]);

  const peers = memberRows.map(r => r.ticker.toUpperCase()).filter(t => t !== key).slice(0, limit);
  return { groupId: classification.groupId, groupName: groupRow[0]?.name ?? null, confidence: classification.confidence, peers };
}

// Classification is DB-backed and effectively static (sector/industry rarely
// changes) — cache per ticker so repeat calls (e.g. getTaxonomyPeers, used by
// GET /stocks/competitors/:ticker) don't re-run the registry lookup (or the
// full peer overlap + keyword-match path for unmapped tickers) every time.
export const classifyCache = new TTLCache<PeerGroupClassification>(24 * 60 * 60 * 1000, "ticker-classify", 1000); // key = ticker

async function getOverride(key: string): Promise<{ groupId: string } | null> {
  const rows = await db.select({ groupId: peerGroupOverrides.groupId })
    .from(peerGroupOverrides).where(eq(peerGroupOverrides.ticker, key)).limit(1);
  return rows[0] ?? null;
}

/** Classify a ticker to its best-fit peer group.
 *  Priority: manual override → DB primary → peer overlap (≥2) → keyword map → unmapped */
export async function classifyTicker(ticker: string): Promise<PeerGroupClassification> {
  const key = ticker.toUpperCase();

  // ETFs never join stock peer cohorts or relative fundamental scoring.
  if (isExcludedEtf(key)) {
    return { groupId: "__global__", confidence: "unmapped" };
  }

  return classifyCache.getOrCompute(key, () => classifyTickerUncached(key));
}

async function classifyTickerUncached(key: string): Promise<PeerGroupClassification> {
  // 0. Manual override always wins
  const override = await getOverride(key);
  if (override) {
    const metricExclusions = await fetchMetricExclusions(override.groupId);
    return { groupId: override.groupId, confidence: "override", metricExclusions };
  }

  // 1. Already mapped in registry — keep roster in sync (heal primary_not_in_roster).
  const regRows = await db
    .select({ primaryPeerGroupId: tickerRegistry.primaryPeerGroupId, sector: tickerRegistry.sector, industryGroup: tickerRegistry.industryGroup })
    .from(tickerRegistry)
    .where(eq(tickerRegistry.ticker, key))
    .limit(1);
  const reg = regRows[0];
  if (reg?.primaryPeerGroupId) {
    await ensureGroupMembership(key, reg.primaryPeerGroupId, "auto");
    const metricExclusions = await fetchMetricExclusions(reg.primaryPeerGroupId);
    return { groupId: reg.primaryPeerGroupId, confidence: "mapped", metricExclusions };
  }

  return computeAutoClassification(key, reg ?? null, { persist: true });
}

/** Peer-overlap + keyword-map classification, ignoring any manual override or
 *  cached primaryPeerGroupId. Used both to bootstrap a never-seen ticker
 *  (persist: true — writes the result back to ticker_registry) and to preview
 *  "what the system default would be" for a ticker that currently has a
 *  manual override (persist: false — read-only). */
async function computeAutoClassification(
  key: string,
  reg: { sector: string | null; industryGroup: string | null } | null,
  opts: { persist: boolean },
): Promise<PeerGroupClassification> {
  // 2. Peer overlap — fetch peers then count group membership / primary overlaps
  try {
    const peersPayload = await resolvePeers(key);
    const peerList = peersPayload.peers.slice(0, 20);

    if (peerList.length > 0) {
      // Prefer curated roster membership (stronger signal).
      const overlapRows = await db
        .select({ groupId: peerGroupMembers.groupId, cnt: count() })
        .from(peerGroupMembers)
        .where(and(inArray(peerGroupMembers.ticker, peerList), isNull(peerGroupMembers.removedAt)))
        .groupBy(peerGroupMembers.groupId)
        .orderBy(desc(count()))
        .limit(1);

      const best = overlapRows[0];
      if (best && Number(best.cnt) >= 2) {
        if (opts.persist) {
          await upsertPrimaryGroup(key, best.groupId);
          logger.info({ ticker: key, groupId: best.groupId, overlap: best.cnt }, "peer-classifier: auto-classified via peer overlap");
        }
        const metricExclusions = await fetchMetricExclusions(best.groupId);
        return { groupId: best.groupId, confidence: "auto", metricExclusions };
      }
    }

    // 3. Keyword map via sector/industry from peers payload or registry
    let sector = peersPayload.sector ?? reg?.sector ?? null;
    let industry = peersPayload.industry ?? reg?.industryGroup ?? null;

    // If subject has no profile meta, borrow majority sector/industry from peers.
    if ((!sector || !industry) && peerList.length > 0) {
      const peerMeta = await db
        .select({
          sector: tickerRegistry.sector,
          industryGroup: tickerRegistry.industryGroup,
        })
        .from(tickerRegistry)
        .where(inArray(tickerRegistry.ticker, peerList));
      if (!sector) {
        sector = majorityString(peerMeta.map(r => r.sector).filter((s): s is string => !!s));
      }
      if (!industry) {
        industry = majorityString(peerMeta.map(r => r.industryGroup).filter((s): s is string => !!s));
      }
    }

    const matched = keywordMatch(sector, industry);
    if (matched) {
      if (opts.persist) {
        await upsertPrimaryGroup(key, matched);
        logger.info({ ticker: key, groupId: matched, sector, industry }, "peer-classifier: auto-classified via keyword map");
      }
      const metricExclusions = await fetchMetricExclusions(matched);
      return { groupId: matched, confidence: "auto", metricExclusions };
    }

    // 4. Soft peer vote — ≥1 peer already mapped (Finnhub thematic clusters).
    if (peerList.length > 0) {
      const primaryVote = await db
        .select({ groupId: tickerRegistry.primaryPeerGroupId, cnt: count() })
        .from(tickerRegistry)
        .where(and(inArray(tickerRegistry.ticker, peerList), isNotNull(tickerRegistry.primaryPeerGroupId)))
        .groupBy(tickerRegistry.primaryPeerGroupId)
        .orderBy(desc(count()))
        .limit(1);
      const bestVote = primaryVote[0];
      if (bestVote?.groupId && Number(bestVote.cnt) >= 1) {
        if (opts.persist) {
          await upsertPrimaryGroup(key, bestVote.groupId);
          logger.info(
            { ticker: key, groupId: bestVote.groupId, vote: bestVote.cnt },
            "peer-classifier: auto-classified via peer primary vote",
          );
        }
        const metricExclusions = await fetchMetricExclusions(bestVote.groupId);
        return { groupId: bestVote.groupId, confidence: "auto", metricExclusions };
      }
    }
  } catch (err) {
    logger.warn({ ticker: key, err: String(err) }, "peer-classifier: classification error");
  }

  // 5. Unmapped
  if (opts.persist) await recordUnmapped(key).catch(() => {});
  return { groupId: "__global__", confidence: "unmapped" };
}

function majorityString(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) { best = v; bestN = n; }
  }
  return best;
}

/** What the auto-classifier would pick for this ticker, ignoring any manual
 *  override (peer_group_overrides) and without touching the DB. Used by the
 *  admin UI to show "default" alongside the current (possibly overridden) group. */
export async function classifyTickerDefault(ticker: string): Promise<PeerGroupClassification> {
  const key = ticker.toUpperCase();
  const regRows = await db
    .select({ sector: tickerRegistry.sector, industryGroup: tickerRegistry.industryGroup })
    .from(tickerRegistry)
    .where(eq(tickerRegistry.ticker, key))
    .limit(1);
  return computeAutoClassification(key, regRows[0] ?? null, { persist: false });
}

/** Set (or replace) a manual peer-group override for a ticker. Writes through to
 *  ticker_registry.primary_peer_group_id so scoring (which reads that column
 *  directly, bypassing classifyTicker) picks it up immediately. */
export async function setPeerGroupOverride(ticker: string, groupId: string, note?: string | null): Promise<void> {
  const key = ticker.toUpperCase();
  if (isExcludedEtf(key)) {
    throw new Error(`${key} is an ETF — cannot assign to a stock peer scoring group`);
  }

  // Only capture previousGroupId on first creation of the override — if the
  // ticker already has an override and is being reassigned again, keep the
  // originally-recorded pre-override value so a later revert goes all the way
  // back to the true default, not to an intermediate override.
  const existing = await db.select({ previousGroupId: peerGroupOverrides.previousGroupId })
    .from(peerGroupOverrides).where(eq(peerGroupOverrides.ticker, key)).limit(1);

  let previousGroupId: string | null;
  if (existing[0]) {
    previousGroupId = existing[0].previousGroupId;
  } else {
    const regRows = await db.select({ primaryPeerGroupId: tickerRegistry.primaryPeerGroupId })
      .from(tickerRegistry).where(eq(tickerRegistry.ticker, key)).limit(1);
    previousGroupId = regRows[0]?.primaryPeerGroupId ?? null;
  }

  await db.insert(peerGroupOverrides)
    .values({ ticker: key, groupId, previousGroupId, note: note ?? null })
    .onConflictDoUpdate({ target: peerGroupOverrides.ticker, set: { groupId, note: note ?? null, createdAt: new Date() } });
  await upsertPrimaryGroup(key, groupId);
  // Override path: membership source = manual (upsertPrimaryGroup used "auto" above — fix stamp).
  await soleActiveMembership(key, groupId, "manual");
  classifyCache.delete(key);
}

/** Remove a manual override, restoring the ticker's pre-override group exactly
 *  (from peer_group_overrides.previous_group_id) rather than re-running
 *  auto-classification, which can land on a different group than the ticker
 *  was originally mapped to. Only falls back to a fresh auto-classification
 *  when the ticker had no prior group (was unmapped before the override). */
export async function clearPeerGroupOverride(ticker: string): Promise<PeerGroupClassification> {
  const key = ticker.toUpperCase();

  const overrideRows = await db.select({ previousGroupId: peerGroupOverrides.previousGroupId })
    .from(peerGroupOverrides).where(eq(peerGroupOverrides.ticker, key)).limit(1);
  await db.delete(peerGroupOverrides).where(eq(peerGroupOverrides.ticker, key));

  const previousGroupId = overrideRows[0]?.previousGroupId ?? null;
  if (previousGroupId) {
    await db.update(tickerRegistry).set({ primaryPeerGroupId: previousGroupId }).where(eq(tickerRegistry.ticker, key));
    classifyCache.delete(key);
    const metricExclusions = await fetchMetricExclusions(previousGroupId);
    return { groupId: previousGroupId, confidence: "mapped", metricExclusions };
  }

  const regRows = await db
    .select({ sector: tickerRegistry.sector, industryGroup: tickerRegistry.industryGroup })
    .from(tickerRegistry)
    .where(eq(tickerRegistry.ticker, key))
    .limit(1);
  const result = await computeAutoClassification(key, regRows[0] ?? null, { persist: true });
  if (result.confidence === "unmapped") {
    await db.update(tickerRegistry).set({ primaryPeerGroupId: null }).where(eq(tickerRegistry.ticker, key));
  }
  classifyCache.delete(key);
  return result;
}
