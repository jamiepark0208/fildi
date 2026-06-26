/**
 * Test Alpha Vantage + Polygon against NVDA, AAPL, PLTR.
 * Covers large-cap, large-cap, and pre-revenue/growth respectively.
 * Logs per data-agent.md format. Updates source_ticker_map.
 * Run: cd artifacts/api-server && npx tsx src/scripts/test-av-polygon.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fetchAVOverview } from "../lib/alpha-vantage-client.js";
import { fetchPolygonFundamentals } from "../lib/polygon-client.js";

const TICKERS = ["NVDA", "AAPL", "PLTR"];
const AV_KEY  = process.env.ALPHA_VANTAGE_API_KEY ?? "";
const POLY_KEY = process.env.POLYGON_API_KEY ?? "";

if (!AV_KEY)   { console.error("ALPHA_VANTAGE_API_KEY not set"); process.exit(1); }
if (!POLY_KEY) { console.error("POLYGON_API_KEY not set");       process.exit(1); }

// ── Types ─────────────────────────────────────────────────────────────────────

interface SourceResult {
  ticker: string;
  source: "polygon" | "alpha_vantage";
  filled: number;
  fields: string[];
  error?: string;
  data: Record<string, number | undefined>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

function countFilled(obj: Record<string, unknown>): { count: number; fields: string[] } {
  const fields = Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k]) => k);
  return { count: fields.length, fields };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function testPolygon(ticker: string): Promise<SourceResult> {
  try {
    const data = await fetchPolygonFundamentals(ticker, POLY_KEY);
    const { count, fields } = countFilled(data as Record<string, unknown>);
    return { ticker, source: "polygon", filled: count, fields, data: data as Record<string, number | undefined> };
  } catch (err) {
    return { ticker, source: "polygon", filled: 0, fields: [], error: String(err), data: {} };
  }
}

async function testAV(ticker: string): Promise<SourceResult> {
  try {
    const data = await fetchAVOverview(ticker, AV_KEY);
    const { count, fields } = countFilled(data as Record<string, unknown>);
    return { ticker, source: "alpha_vantage", filled: count, fields, error: undefined, data: data as Record<string, number | undefined> };
  } catch (err) {
    return { ticker, source: "alpha_vantage", filled: 0, fields: [], error: String(err), data: {} };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results: SourceResult[] = [];

  console.log(`[${ts()}] Starting AV + Polygon test — tickers: ${TICKERS.join(", ")}`);

  // ── Polygon (5/min rate limit — 1s gap is plenty) ────────────────────────
  console.log(`\n[${ts()}] === POLYGON ===`);
  for (const ticker of TICKERS) {
    const r = await testPolygon(ticker);
    results.push(r);
    if (r.error) {
      console.log(`  [${ts()}] ${ticker} polygon  ERROR: ${r.error}`);
    } else {
      console.log(`  [${ts()}] ${ticker} polygon  filled:${r.filled} fields:[${r.fields.join(",")}]`);
      console.log(`           data: ${JSON.stringify(r.data, null, 0)}`);
    }
    await sleep(500);
  }

  // ── Alpha Vantage (25/day — 1s gap between calls) ────────────────────────
  console.log(`\n[${ts()}] === ALPHA VANTAGE ===`);
  for (const ticker of TICKERS) {
    const r = await testAV(ticker);
    results.push(r);
    if (r.error) {
      console.log(`  [${ts()}] ${ticker} alpha_vantage  ERROR: ${r.error}`);
    } else {
      console.log(`  [${ts()}] ${ticker} alpha_vantage  filled:${r.filled} fields:[${r.fields.join(",")}]`);
      console.log(`           data: ${JSON.stringify(r.data, null, 0)}`);
    }
    await sleep(1200); // AV free tier: 1 req/sec sustained
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const polyResults  = results.filter(r => r.source === "polygon");
  const avResults    = results.filter(r => r.source === "alpha_vantage");
  const polyFilled   = polyResults.reduce((s, r) => s + r.filled, 0);
  const avFilled     = avResults.reduce((s, r) => s + r.filled, 0);
  const polyOk       = polyResults.filter(r => r.filled > 0).length;
  const avOk         = avResults.filter(r => r.filled > 0).length;

  const summaryLines = [
    `[${ts()}] BATCH ${TICKERS.join(",")} | filled:${polyFilled + avFilled} | null:${results.filter(r => r.filled === 0).length} | sources:polygon(${polyOk}) alpha_vantage(${avOk})`,
    `[${ts()}] SESSION COMPLETE | tickers:${TICKERS.length} | filled:${polyOk + avOk} | still_null:${results.filter(r => r.filled === 0).length}`,
    `         polygon_coverage: ${polyResults.map(r => `${r.ticker}:${r.filled}fields`).join(" ")}`,
    `         av_coverage:      ${avResults.map(r => `${r.ticker}:${r.filled}fields`).join(" ")}`,
    `         errors:           ${results.filter(r => r.error).map(r => `${r.ticker}/${r.source}:${r.error}`).join(" ") || "none"}`,
  ];

  console.log(`\n${summaryLines.join("\n")}`);

  // ── Write log ─────────────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const logDir = path.resolve(import.meta.dirname, "../../../../logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `data-agent-${today}.log`);
  fs.appendFileSync(logFile, summaryLines.join("\n") + "\n");
  console.log(`\n[${ts()}] Log written to ${logFile}`);

  // ── source_ticker_map summary (for reference — SDM wires DB updates) ──────
  console.log(`\n[${ts()}] source_ticker_map entries to expect:`);
  for (const r of results) {
    const active = r.filled > 0 ? "true " : "false";
    console.log(`  ticker=${r.ticker} source=${r.source} active=${active} filled=${r.filled}`);
  }
}

main().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
