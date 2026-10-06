/**
 * Peer-group health check + heal.
 *
 *   pnpm exec tsx src/scripts/peer-health-check.ts           # audit + heal
 *   pnpm exec tsx src/scripts/peer-health-check.ts --dry-run # audit only
 *
 * Heals (unless --dry-run):
 *   - primary with missing active roster row → insert membership
 *   - ETF on deny-list still fetch_fundamentals / primary → quarantine
 *   - fetch_fundamentals=true with null primary → classifyTicker
 *
 * Flags (printed for weekly review; no silent rewrites):
 *   - keyword map (sector|industry) disagrees with current primary
 *   - tiny scoring cohorts (n < 3)
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  db,
  tickerRegistry,
  peerGroupMembers,
  peerGroups,
  peerGroupOverrides,
  unmappedTickers,
  ETF_EXCLUSIONS,
  isExcludedEtf,
} from "@workspace/db";
import {
  classifyTicker,
  suggestGroupFromSectorIndustry,
  classifyCache,
} from "../lib/peer-classifier.js";

const DRY_RUN = process.argv.includes("--dry-run");
const REPORT_PATH = "/tmp/fildi-logs/peer-health-last.json";

type Report = {
  ts: string;
  dryRun: boolean;
  healed: {
    rosterGaps: number;
    etfQuarantined: string[];
    newlyMapped: Array<{ ticker: string; groupId: string; confidence: string }>;
  };
  remaining: {
    ffUnmapped: string[];
    rosterGaps: string[];
    etfsStillInUniverse: string[];
  };
  flags: {
    keywordMismatch: Array<{
      ticker: string;
      primary: string;
      suggested: string;
      sector: string | null;
      industry: string | null;
    }>;
    tinyGroups: Array<{ groupId: string; name: string | null; n: number }>;
    overrides: number;
    unmappedQueue: number;
  };
  counts: {
    ff: number;
    ffMapped: number;
    groups: number;
    activeMembers: number;
  };
};

async function findRosterGaps(): Promise<Array<{ ticker: string; groupId: string }>> {
  const result = await db.execute(sql`
    SELECT tr.ticker, tr.primary_peer_group_id AS "groupId"
    FROM ticker_registry tr
    WHERE tr.fetch_fundamentals = true
      AND tr.primary_peer_group_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM peer_group_members m
        WHERE m.group_id = tr.primary_peer_group_id
          AND m.ticker = tr.ticker
          AND m.removed_at IS NULL
      )
  `);
  const rows = (result as unknown as { rows?: Array<{ ticker: string; groupId: string }> }).rows
    ?? (result as unknown as Array<{ ticker: string; groupId: string }>);
  return Array.isArray(rows) ? rows : [];
}

async function healRosterGaps(): Promise<{ healed: number; remaining: string[] }> {
  const gaps = await findRosterGaps();
  if (DRY_RUN || gaps.length === 0) {
    return { healed: 0, remaining: gaps.map((g) => g.ticker) };
  }
  for (const g of gaps) {
    await db
      .insert(peerGroupMembers)
      .values({ groupId: g.groupId, ticker: g.ticker, source: "auto", removedAt: null })
      .onConflictDoUpdate({
        target: [peerGroupMembers.groupId, peerGroupMembers.ticker],
        set: { removedAt: null },
      });
  }
  return { healed: gaps.length, remaining: [] };
}

async function quarantineEtfs(): Promise<{ quarantined: string[]; stillIn: string[] }> {
  const etfList = [...ETF_EXCLUSIONS];
  if (etfList.length === 0) return { quarantined: [], stillIn: [] };

  const rows = await db
    .select({
      ticker: tickerRegistry.ticker,
      fetchFundamentals: tickerRegistry.fetchFundamentals,
      primaryPeerGroupId: tickerRegistry.primaryPeerGroupId,
    })
    .from(tickerRegistry)
    .where(inArray(tickerRegistry.ticker, etfList));

  const dirty = rows.filter((r) => r.fetchFundamentals || r.primaryPeerGroupId != null);
  if (DRY_RUN) return { quarantined: [], stillIn: dirty.map((r) => r.ticker) };

  const quarantined: string[] = [];
  for (const r of dirty) {
    await db
      .update(tickerRegistry)
      .set({ fetchFundamentals: false, primaryPeerGroupId: null })
      .where(eq(tickerRegistry.ticker, r.ticker));
    await db
      .update(peerGroupMembers)
      .set({ removedAt: new Date() })
      .where(and(eq(peerGroupMembers.ticker, r.ticker), isNull(peerGroupMembers.removedAt)));
    classifyCache.delete(r.ticker);
    quarantined.push(r.ticker);
  }
  return { quarantined, stillIn: [] };
}

async function classifyMissing(): Promise<{
  newlyMapped: Array<{ ticker: string; groupId: string; confidence: string }>;
  stillUnmapped: string[];
}> {
  const rows = await db
    .select({ ticker: tickerRegistry.ticker })
    .from(tickerRegistry)
    .where(and(eq(tickerRegistry.fetchFundamentals, true), isNull(tickerRegistry.primaryPeerGroupId)));

  const candidates = rows.map((r) => r.ticker).filter((t) => !isExcludedEtf(t));
  const newlyMapped: Array<{ ticker: string; groupId: string; confidence: string }> = [];
  const stillUnmapped: string[] = [];

  for (const ticker of candidates) {
    if (DRY_RUN) {
      stillUnmapped.push(ticker);
      continue;
    }
    try {
      classifyCache.delete(ticker);
      const res = await classifyTicker(ticker);
      if (res.groupId && res.groupId !== "__global__" && res.confidence !== "unmapped") {
        newlyMapped.push({ ticker, groupId: res.groupId, confidence: res.confidence });
      } else {
        stillUnmapped.push(ticker);
      }
    } catch {
      stillUnmapped.push(ticker);
    }
  }
  return { newlyMapped, stillUnmapped };
}

async function keywordMismatchFlags(): Promise<Report["flags"]["keywordMismatch"]> {
  const rows = await db
    .select({
      ticker: tickerRegistry.ticker,
      primary: tickerRegistry.primaryPeerGroupId,
      sector: tickerRegistry.sector,
      industry: tickerRegistry.industryGroup,
    })
    .from(tickerRegistry)
    .where(and(eq(tickerRegistry.fetchFundamentals, true), sql`${tickerRegistry.primaryPeerGroupId} IS NOT NULL`));

  const out: Report["flags"]["keywordMismatch"] = [];
  for (const r of rows) {
    if (!r.primary || isExcludedEtf(r.ticker)) continue;
    if (!r.sector && !r.industry) continue;
    const suggested = suggestGroupFromSectorIndustry(r.sector, r.industry);
    if (suggested && suggested !== r.primary) {
      out.push({
        ticker: r.ticker,
        primary: r.primary,
        suggested,
        sector: r.sector,
        industry: r.industry,
      });
    }
  }
  return out.slice(0, 40);
}

async function tinyGroups(): Promise<Report["flags"]["tinyGroups"]> {
  const rows = await db
    .select({
      groupId: tickerRegistry.primaryPeerGroupId,
      n: sql<number>`count(*)::int`,
    })
    .from(tickerRegistry)
    .where(and(eq(tickerRegistry.fetchFundamentals, true), sql`${tickerRegistry.primaryPeerGroupId} IS NOT NULL`))
    .groupBy(tickerRegistry.primaryPeerGroupId);

  const small = rows.filter((r) => r.groupId && r.n < 3);
  if (small.length === 0) return [];

  const ids = small.map((r) => r.groupId!).filter(Boolean);
  const names = await db
    .select({ id: peerGroups.id, name: peerGroups.name })
    .from(peerGroups)
    .where(inArray(peerGroups.id, ids));
  const nameById = new Map(names.map((g) => [g.id, g.name]));

  return small.map((r) => ({
    groupId: r.groupId!,
    name: nameById.get(r.groupId!) ?? null,
    n: r.n,
  }));
}

async function main() {
  const roster = await healRosterGaps();
  const etfs = await quarantineEtfs();
  const mapped = await classifyMissing();
  const mismatches = await keywordMismatchFlags();
  const tiny = await tinyGroups();
  const remainingGaps = (await findRosterGaps()).map((g) => g.ticker);

  const [ffStats] = await db
    .select({
      ff: sql<number>`count(*) filter (where ${tickerRegistry.fetchFundamentals})::int`,
      ffMapped: sql<number>`count(*) filter (where ${tickerRegistry.fetchFundamentals} and ${tickerRegistry.primaryPeerGroupId} is not null)::int`,
    })
    .from(tickerRegistry);

  const [groupCount] = await db.select({ n: sql<number>`count(*)::int` }).from(peerGroups);
  const [memberCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(peerGroupMembers)
    .where(isNull(peerGroupMembers.removedAt));
  const [overrideCount] = await db.select({ n: sql<number>`count(*)::int` }).from(peerGroupOverrides);
  const [unmappedCount] = await db.select({ n: sql<number>`count(*)::int` }).from(unmappedTickers);

  const report: Report = {
    ts: new Date().toISOString(),
    dryRun: DRY_RUN,
    healed: {
      rosterGaps: roster.healed,
      etfQuarantined: etfs.quarantined,
      newlyMapped: mapped.newlyMapped,
    },
    remaining: {
      ffUnmapped: mapped.stillUnmapped,
      rosterGaps: remainingGaps,
      etfsStillInUniverse: etfs.stillIn,
    },
    flags: {
      keywordMismatch: mismatches,
      tinyGroups: tiny,
      overrides: overrideCount?.n ?? 0,
      unmappedQueue: unmappedCount?.n ?? 0,
    },
    counts: {
      ff: ffStats?.ff ?? 0,
      ffMapped: ffStats?.ffMapped ?? 0,
      groups: groupCount?.n ?? 0,
      activeMembers: memberCount?.n ?? 0,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  try {
    mkdirSync("/tmp/fildi-logs", { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.error(`[peer-health] wrote ${REPORT_PATH}`);
  } catch (err) {
    console.error(`[peer-health] failed to write report: ${err}`);
  }

  const critical =
    report.remaining.ffUnmapped.length > 0 ||
    report.remaining.rosterGaps.length > 0 ||
    report.remaining.etfsStillInUniverse.length > 0;

  // dry-run never fails the weekly job; live heal fails if anything left unclean
  process.exit(critical && !DRY_RUN ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
