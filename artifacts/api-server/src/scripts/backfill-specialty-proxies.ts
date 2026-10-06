#!/usr/bin/env npx tsx
/**
 * Backfill specialty free proxies:
 *   - Finnhub tangibleBookValuePerShare → bronze + gold (banks/financials)
 *   - EDGAR D&A → bronze + gold depreciation + ffoProxy = NI + D&A (REITs)
 *
 * Then populate-source + merge-trusted + score recompute.
 *
 *   cd artifacts/api-server && npx tsx src/scripts/backfill-specialty-proxies.ts
 *   cd artifacts/api-server && npx tsx src/scripts/backfill-specialty-proxies.ts --dry-run
 */
import { sleep } from "../lib/http-client.js";
import { sql } from "drizzle-orm";
import {
  db,
  finnhubFundamentals,
  edgarFundamentals,
  tickerFundamentals,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { fetchFinnhubFundamentals } from "../lib/finnhub-client.js";
import { fetchEdgarFundamentals } from "../lib/edgar-client.js";

const dryRun = process.argv.includes("--dry-run");

async function financialTickers(): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT UPPER(pgm.ticker) AS ticker
    FROM peer_group_members pgm
    JOIN peer_groups pg ON pg.id = pgm.group_id
    WHERE pg.scoring_mode IN ('financial', 'insurance', 'financial_mixed')
       OR pg.id ILIKE '%bank%'
       OR pg.id ILIKE '%insur%'
       OR pg.id ILIKE '%broker%'
       OR pg.id ILIKE '%asset_manag%'
    ORDER BY 1
  `);
  const list = ((rows as any).rows ?? rows) as { ticker: string }[];
  return list.map((r) => r.ticker).filter(Boolean);
}

async function reitTickers(): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT UPPER(pgm.ticker) AS ticker
    FROM peer_group_members pgm
    JOIN peer_groups pg ON pg.id = pgm.group_id
    WHERE pg.scoring_mode = 'reit'
       OR pg.id ILIKE '%reit%'
    ORDER BY 1
  `);
  const list = ((rows as any).rows ?? rows) as { ticker: string }[];
  return list.map((r) => r.ticker).filter(Boolean);
}

async function backfillTbv(tickers: string[]) {
  let ok = 0, miss = 0, fail = 0;
  for (const t of tickers) {
    try {
      const data = await fetchFinnhubFundamentals(t);
      const tbv = data.finnhub_tangibleBookValuePerShare;
      if (tbv == null || !Number.isFinite(tbv)) {
        miss++;
        console.log(`[tbv] ${t} — no tangibleBookValuePerShare`);
        await sleep(1300);
        continue;
      }
      if (dryRun) {
        console.log(`[tbv] ${t} dry-run ${tbv}`);
        ok++;
        await sleep(200);
        continue;
      }
      await db.insert(finnhubFundamentals).values({
        ticker: t,
        fetchedAt: new Date(),
        finnhubTangibleBookValuePerShare: String(tbv),
      } as any).onConflictDoUpdate({
        target: finnhubFundamentals.ticker,
        set: {
          fetchedAt: sql`now()`,
          finnhubTangibleBookValuePerShare: String(tbv),
        } as any,
      });
      await db.update(tickerFundamentals)
        .set({ tangibleBookValuePerShare: String(tbv) } as any)
        .where(eq(tickerFundamentals.ticker, t));
      ok++;
      console.log(`[tbv] ${t} = ${tbv}`);
      await sleep(1300);
    } catch (e: any) {
      fail++;
      console.warn(`[tbv] ${t} fail: ${e?.message ?? e}`);
      await sleep(2000);
    }
  }
  return { ok, miss, fail };
}

async function backfillDaFfo(tickers: string[]) {
  let ok = 0, miss = 0, fail = 0;
  for (const t of tickers) {
    try {
      const { data } = await fetchEdgarFundamentals(t);
      const da = data.edgar_depreciationAmortization;
      if (da == null || !Number.isFinite(da)) {
        miss++;
        console.log(`[da] ${t} — no D&A`);
        await sleep(400);
        continue;
      }
      const gold = await db.select({
        ni: tickerFundamentals.netIncome,
      }).from(tickerFundamentals).where(eq(tickerFundamentals.ticker, t)).limit(1);
      const ni = gold[0]?.ni != null ? Number(gold[0].ni) : null;
      const ffo = ni != null && Number.isFinite(ni) ? ni + da : null;
      if (dryRun) {
        console.log(`[da] ${t} dry-run da=${da} ffo=${ffo}`);
        ok++;
        await sleep(200);
        continue;
      }
      await db.insert(edgarFundamentals).values({
        ticker: t,
        fetchedAt: new Date(),
        edgarDepreciationAmortization: String(da),
      } as any).onConflictDoUpdate({
        target: edgarFundamentals.ticker,
        set: {
          fetchedAt: sql`now()`,
          edgarDepreciationAmortization: String(da),
        } as any,
      });
      await db.update(tickerFundamentals)
        .set({
          depreciationAmortization: String(da),
          ...(ffo != null ? { ffoProxy: String(ffo) } : {}),
        } as any)
        .where(eq(tickerFundamentals.ticker, t));
      ok++;
      console.log(`[da] ${t} da=${da} ffo=${ffo}`);
      await sleep(400);
    } catch (e: any) {
      fail++;
      console.warn(`[da] ${t} fail: ${e?.message ?? e}`);
      await sleep(1000);
    }
  }
  return { ok, miss, fail };
}

async function main() {
  const fins = await financialTickers();
  const reits = await reitTickers();
  console.log(`financials=${fins.length} reits=${reits.length} dryRun=${dryRun}`);

  const tbv = await backfillTbv(fins);
  const da = await backfillDaFfo(reits);
  console.log(JSON.stringify({ tbv, da }, null, 2));

  if (dryRun) return;

  // Recompute scores with new fields in gold
  const { computeAndPersistFundamentalScores } = await import("../lib/fundamentals-db.js");
  const { marketRegime } = await import("@workspace/db");
  const { desc } = await import("drizzle-orm");
  const rows = await db.select({ regime: marketRegime.regime }).from(marketRegime).orderBy(desc(marketRegime.computedAt)).limit(1);
  const regime = rows[0]?.regime ?? null;
  const results = await computeAndPersistFundamentalScores(regime);
  const ranked = results.filter((r) => r.ranked);
  console.log(JSON.stringify({
    regime,
    ranked: ranked.length,
    top10: ranked.slice(0, 10).map((r) => ({
      ticker: r.ticker,
      total: r.totalScore,
      style: r.styleBucket,
    })),
  }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
