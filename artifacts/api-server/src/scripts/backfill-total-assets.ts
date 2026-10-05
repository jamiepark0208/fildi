/**
 * Ad-hoc backfill for gold `total_assets` (fund-score GPA / accruals / F-Score).
 *
 * Strategy (cheapest first):
 *   1. FMP `/balance-sheet-statement?limit=1` only — 1 call/ticker (not full 9-endpoint fetch)
 *   2. Derive from NI / ROA when same-sign and |ROA| > 0.001 (identity when ROA is NI/Assets)
 *
 * Writes `fmp_fundamentals.fmp_total_assets` for FMP hits, then gold `ticker_fundamentals.total_assets`.
 *
 *   pnpm exec tsx src/scripts/backfill-total-assets.ts
 *   pnpm exec tsx src/scripts/backfill-total-assets.ts --derive-only
 *   pnpm exec tsx src/scripts/backfill-total-assets.ts --max=50
 */
import { sql, eq, and, isNull } from "drizzle-orm";
import { db, fmpFundamentals, tickerFundamentals, tickerRegistry } from "@workspace/db";
import { checkFMPBudget, recordFMPCalls } from "../lib/fundamentals-db.js";
import { fetchJsonWithRetry } from "../lib/http-client.js";

const FMP_BASE = "https://financialmodelingprep.com/stable";
const FMP_API_KEY = process.env.FMP_API_KEY ?? "";
const DERIVE_ONLY = process.argv.includes("--derive-only");
const maxArg = process.argv.find((a) => a.startsWith("--max="));
const MAX = maxArg ? Number(maxArg.split("=")[1]) : Infinity;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function n(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** Assets = NI / ROA when signs agree and ROA is not ~0. */
export function deriveTotalAssets(netIncome: number | null, roa: number | null): number | null {
  if (netIncome == null || roa == null) return null;
  if (Math.abs(roa) < 0.001) return null;
  if (netIncome * roa <= 0) return null; // inconsistent signs
  const assets = netIncome / roa;
  if (!Number.isFinite(assets) || assets <= 0) return null;
  return assets;
}

/** Rough BS identity when NI/ROA disagree: Assets ≈ Debt + Equity. */
export function deriveTotalAssetsFromDebtEquity(
  totalDebt: number | null,
  equity: number | null,
): number | null {
  if (equity == null || equity <= 0) return null;
  const debt = totalDebt != null && totalDebt > 0 ? totalDebt : 0;
  const assets = debt + equity;
  return Number.isFinite(assets) && assets > 0 ? assets : null;
}

async function fetchBalanceSheetTotalAssets(ticker: string): Promise<number | null> {
  const url = `${FMP_BASE}/balance-sheet-statement?symbol=${encodeURIComponent(ticker)}&limit=1&apikey=${FMP_API_KEY}`;
  const raw = await fetchJsonWithRetry(url, { provider: "FMP", maxRetries: 2 });
  const row = Array.isArray(raw) && raw.length > 0 ? raw[0] : null;
  return n(row?.totalAssets);
}

async function main() {
  const missing = await db
    .select({
      ticker: tickerFundamentals.ticker,
      netIncome: tickerFundamentals.netIncome,
      roa: tickerFundamentals.returnOnAssets,
      totalDebt: tickerFundamentals.totalDebt,
      equity: tickerFundamentals.totalStockholdersEquity,
    })
    .from(tickerFundamentals)
    .innerJoin(tickerRegistry, eq(tickerFundamentals.ticker, tickerRegistry.ticker))
    .where(and(eq(tickerRegistry.fetchFundamentals, true), isNull(tickerFundamentals.totalAssets)));

  console.log(`missing total_assets: ${missing.length}`);

  let fmpOk = 0;
  let fmpFail = 0;
  let derived = 0;
  let debtEquity = 0;
  let skipped = 0;
  let budgetStop = false;
  let fmp402 = false;

  const budget0 = await checkFMPBudget(0);
  console.log(`FMP budget: used=${budget0.callsToday} remaining=${budget0.remaining}`);

  const queue = missing.slice(0, Number.isFinite(MAX) ? MAX : missing.length);

  for (const row of queue) {
    const t = row.ticker.toUpperCase();
    let assets: number | null = null;
    let source: "fmp" | "derived" | "debt_equity" | null = null;

    if (!DERIVE_ONLY && !budgetStop && !fmp402) {
      const bud = await checkFMPBudget(1);
      if (!bud.allowed) {
        console.log(`BUDGET_STOP remaining=${bud.remaining} — switching to derive-only`);
        budgetStop = true;
      } else if (!FMP_API_KEY) {
        console.log("WARN: FMP_API_KEY missing — derive-only");
        budgetStop = true;
      } else {
        try {
          assets = await fetchBalanceSheetTotalAssets(t);
          await recordFMPCalls(1);
          if (assets != null && assets > 0) {
            source = "fmp";
            fmpOk++;
            await db
              .insert(fmpFundamentals)
              .values({
                ticker: t,
                fetchedAt: new Date(),
                fmpTotalAssets: String(assets),
              })
              .onConflictDoUpdate({
                target: fmpFundamentals.ticker,
                set: {
                  fetchedAt: sql`now()`,
                  fmpTotalAssets: sql`excluded.fmp_total_assets`,
                },
              });
          } else {
            fmpFail++;
          }
        } catch (err: any) {
          fmpFail++;
          const msg = String(err?.message ?? err);
          console.log(`[${t}] FMP fail: ${msg}`);
          if (msg.includes("402")) fmp402 = true; // plan blocked — stop burning calls
        }
        await sleep(250);
      }
    }

    if (assets == null) {
      assets = deriveTotalAssets(n(row.netIncome), n(row.roa));
      if (assets != null) {
        source = "derived";
        derived++;
      }
    }
    if (assets == null) {
      assets = deriveTotalAssetsFromDebtEquity(n(row.totalDebt), n(row.equity));
      if (assets != null) {
        source = "debt_equity";
        debtEquity++;
      }
    }

    if (assets == null || source == null) {
      skipped++;
      continue;
    }

    await db
      .update(tickerFundamentals)
      .set({ totalAssets: String(Math.round(assets)) })
      .where(eq(tickerFundamentals.ticker, t));
  }

  const leftRows = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM ticker_fundamentals tf
    JOIN ticker_registry r ON r.ticker = tf.ticker AND r.fetch_fundamentals
    WHERE tf.total_assets IS NULL
  `);
  const stillMissing = Number((leftRows as any).rows?.[0]?.n ?? (leftRows as any)[0]?.n ?? 0);

  console.log(
    JSON.stringify({ fmpOk, fmpFail, derived, debtEquity, skipped, stillMissing, fmp402 }, null, 2),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
