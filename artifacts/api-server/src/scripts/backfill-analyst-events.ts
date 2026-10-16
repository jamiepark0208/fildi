/**
 * Backfill Yahoo analyst upgrade/downgrade history for all fundamentals-tracked tickers.
 *
 * Logic:
 *   - Distinct tickers from ticker_registry where fetch_fundamentals = true
 *   - Skip tickers with an analyst_events row fetched within STALE_DAYS
 *   - Fetch via yahoo-finance2 quoteSummary (upgradeDowngradeHistory module only)
 *   - Upsert bronze (yahoo_analyst_actions) + gold (analyst_events) in one transaction
 *   - Max 3 concurrent fetches
 *   - Log to logs/backfill-analyst-{date}.log
 *
 * Run: cd artifacts/api-server && tsx src/scripts/backfill-analyst-events.ts
 *      cd artifacts/api-server && tsx src/scripts/backfill-analyst-events.ts --force
 * `--force` re-fetches every ticker (A97: rewrite Yahoo rows with price targets).
 */

import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, tickerRegistry } from "@workspace/db";
import { fetchYahooAnalystActions } from "../lib/yahoo-analyst-client.js";
import { getStaleAnalystTickers, writeAnalystEvents } from "../lib/analyst-events.js";

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_CONCURRENT = 3;

// ── Log file ──────────────────────────────────────────────────────────────────

const today   = new Date().toISOString().slice(0, 10);
const logDir  = path.resolve(new URL(import.meta.url).pathname, "../../../../../logs");
const logFile = path.join(logDir, `backfill-analyst-${today}.log`);

fs.mkdirSync(logDir, { recursive: true });

function ts() { return new Date().toISOString(); }

function appendLog(line: string): void {
  const stamped = `[${ts()}] ${line}`;
  console.log(stamped);
  fs.appendFileSync(logFile, stamped + "\n");
}

// ── Core per-ticker logic ─────────────────────────────────────────────────────

type TickerResult = { ticker: string; status: "ok" | "skip" | "fail"; events?: number; reason?: string };

async function processTicker(ticker: string, staleSet: Set<string>): Promise<TickerResult> {
  if (!staleSet.has(ticker)) {
    appendLog(`[${ticker}] SKIP — fresh`);
    return { ticker, status: "skip" };
  }

  let rawHistory: unknown[];
  try {
    rawHistory = await fetchYahooAnalystActions(ticker);
  } catch (err: any) {
    const reason = err?.message ?? "unknown error";
    appendLog(`[${ticker}] FAIL — ${reason}`);
    return { ticker, status: "fail", reason };
  }

  try {
    await writeAnalystEvents(ticker, rawHistory);
  } catch (err: any) {
    const reason = err?.message ?? "db write failed";
    appendLog(`[${ticker}] FAIL — ${reason}`);
    return { ticker, status: "fail", reason };
  }

  appendLog(`[${ticker}] OK — ${rawHistory.length} raw events`);
  return { ticker, status: "ok", events: rawHistory.length };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  appendLog(`backfill-analyst-events starting${force ? " (--force)" : ""}`);

  const allTickers = (await db
    .select({ ticker: tickerRegistry.ticker })
    .from(tickerRegistry)
    .where(eq(tickerRegistry.fetchFundamentals, true))
    .orderBy(tickerRegistry.ticker))
    .map(r => r.ticker);
  appendLog(`${allTickers.length} tickers (fetch_fundamentals=true)`);

  const staleTickers = force ? allTickers : await getStaleAnalystTickers(allTickers);
  const staleSet = new Set(staleTickers);
  appendLog(force
    ? `force: re-fetching all ${staleSet.size}`
    : `${allTickers.length - staleSet.size} tickers already fresh — will skip`);

  const results: TickerResult[] = [];
  for (let i = 0; i < allTickers.length; i += MAX_CONCURRENT) {
    const chunk = allTickers.slice(i, i + MAX_CONCURRENT);
    const chunkResults = await Promise.all(chunk.map(t => processTicker(t, staleSet)));
    results.push(...chunkResults);
  }

  const ok   = results.filter(r => r.status === "ok");
  const skip = results.filter(r => r.status === "skip");
  const fail = results.filter(r => r.status === "fail");
  const totalEvents = ok.reduce((s, r) => s + (r.events ?? 0), 0);

  const summary = [
    "",
    "── backfill-analyst-events summary ─────────",
    `  Total tickers : ${allTickers.length}`,
    `  Processed     : ${ok.length}`,
    `  Skipped       : ${skip.length}`,
    `  Failed        : ${fail.length}`,
    `  Events written: ${totalEvents}`,
    fail.length > 0 ? `  Failures      : ${fail.map(r => r.ticker).join(", ")}` : "",
    "────────────────────────────────────────────",
  ].filter(l => l !== "");

  for (const line of summary) appendLog(line);
}

main().catch(err => {
  appendLog(`FATAL — ${err.message}`);
  process.exit(1);
});
