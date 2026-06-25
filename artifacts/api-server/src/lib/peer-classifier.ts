import { eq, inArray, count, desc } from "drizzle-orm";
import { db, tickerRegistry, peerGroupMembers, peerGroups, unmappedTickers } from "@workspace/db";
import { resolvePeers } from "./peer-resolver.js";
import { logger } from "./logger.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..", "..");
const OVERRIDES_FILE = join(ROOT, "config", "ticker-mapping-overrides.json");

export type PeerGroupClassification = {
  groupId: string;
  confidence: "mapped" | "auto" | "unmapped";
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
  // Communication Services
  { keywords: ["internet content", "internet retail", "entertainment"],  groupId: "technology.consumer_internet_digital_media" },
  { keywords: ["telecom"],                              groupId: "telecom.telecommunications" },
  { keywords: ["broadcasting", "media"],                groupId: "technology.consumer_internet_digital_media" },
  // Financial Services
  { keywords: ["banks—diversified", "banks-diversified", "diversified bank"],  groupId: "financials.large_banks" },
  { keywords: ["banks—regional", "banks-regional", "regional bank"],           groupId: "financials.regional_banks" },
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
  { keywords: ["waste management"],                     groupId: "industrials.waste_management_services" },
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
  { keywords: ["copper", "aluminum", "base metals"],    groupId: "materials.base_metals_mining" },
  { keywords: ["steel"],                                groupId: "materials.steel_industrial_metals" },
  { keywords: ["chemicals", "agricultural chemicals"],  groupId: "materials.chemicals" },
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

async function appendOverride(ticker: string, groupId: string): Promise<void> {
  try {
    await mkdir(dirname(OVERRIDES_FILE), { recursive: true });
    let existing: Record<string, string> = {};
    try {
      const raw = await readFile(OVERRIDES_FILE, "utf-8");
      existing = JSON.parse(raw);
    } catch {
      // file missing or invalid — start fresh
    }
    existing[ticker] = groupId;
    await writeFile(OVERRIDES_FILE, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  } catch (err) {
    logger.warn({ ticker, err: String(err) }, "peer-classifier: failed to write overrides file");
  }
}

async function upsertPrimaryGroup(ticker: string, groupId: string): Promise<void> {
  await db.insert(tickerRegistry)
    .values({ ticker, primaryPeerGroupId: groupId })
    .onConflictDoUpdate({
      target: tickerRegistry.ticker,
      set: { primaryPeerGroupId: groupId },
    });
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

/** Classify a ticker to its best-fit peer group.
 *  Priority: DB primary → peer overlap (≥2) → keyword map → unmapped */
export async function classifyTicker(ticker: string): Promise<PeerGroupClassification> {
  const key = ticker.toUpperCase();

  // 1. Already mapped in registry
  const regRows = await db
    .select({ primaryPeerGroupId: tickerRegistry.primaryPeerGroupId, sector: tickerRegistry.sector, industryGroup: tickerRegistry.industryGroup })
    .from(tickerRegistry)
    .where(eq(tickerRegistry.ticker, key))
    .limit(1);
  const reg = regRows[0];
  if (reg?.primaryPeerGroupId) {
    const metricExclusions = await fetchMetricExclusions(reg.primaryPeerGroupId);
    return { groupId: reg.primaryPeerGroupId, confidence: "mapped", metricExclusions };
  }

  // 2. Peer overlap — fetch peers then count group membership overlaps
  try {
    const peersPayload = await resolvePeers(key);
    const peerList = peersPayload.peers.slice(0, 20);

    if (peerList.length > 0) {
      const overlapRows = await db
        .select({ groupId: peerGroupMembers.groupId, cnt: count() })
        .from(peerGroupMembers)
        .where(inArray(peerGroupMembers.ticker, peerList))
        .groupBy(peerGroupMembers.groupId)
        .orderBy(desc(count()))
        .limit(1);

      const best = overlapRows[0];
      if (best && Number(best.cnt) >= 2) {
        await upsertPrimaryGroup(key, best.groupId);
        await appendOverride(key, best.groupId);
        logger.info({ ticker: key, groupId: best.groupId, overlap: best.cnt }, "peer-classifier: auto-classified via peer overlap");
        const metricExclusions = await fetchMetricExclusions(best.groupId);
        return { groupId: best.groupId, confidence: "auto", metricExclusions };
      }
    }

    // 3. Keyword map via sector/industry from peers payload or registry
    const sector = peersPayload.sector ?? reg?.sector ?? null;
    const industry = peersPayload.industry ?? reg?.industryGroup ?? null;
    const matched = keywordMatch(sector, industry);
    if (matched) {
      await upsertPrimaryGroup(key, matched);
      await appendOverride(key, matched);
      logger.info({ ticker: key, groupId: matched, sector, industry }, "peer-classifier: auto-classified via keyword map");
      const metricExclusions = await fetchMetricExclusions(matched);
      return { groupId: matched, confidence: "auto", metricExclusions };
    }
  } catch (err) {
    logger.warn({ ticker: key, err: String(err) }, "peer-classifier: classification error");
  }

  // 4. Unmapped
  await recordUnmapped(key).catch(() => {});
  return { groupId: "__global__", confidence: "unmapped" };
}
