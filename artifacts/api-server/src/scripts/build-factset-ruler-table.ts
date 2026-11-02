import { sql } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { db } from "@workspace/db";
import {
  factsetWithinBand,
  RULER_JSON,
  type RulerTable,
  valuesAgreeField,
} from "../lib/factset-ruler-table.js";

const FREE_SOURCES = ["yahoo", "finnhub", "fmp", "edgar", "polygon", "alpha_vantage"] as const;
const MIN_CLUSTER_REL = 0.1;
const FACTSET_BAND_REL = 0.2;
const RULER_THRESHOLD = 0.8;

/** Map source_fundamentals.field → ticker_fundamentals column where they differ. */
const SF_TO_TF: Record<string, string> = {
  totalCash: "cashAndEquivalents",
  annualTotalRevenue: "totalRevenue",
  annualNetIncome: "netIncome",
  trailingEps: "earningsPerShare",
  totalEquity: "totalStockholdersEquity",
};

function tfCol(sfField: string): string {
  return SF_TO_TF[sfField] ?? sfField;
}

function clusterGate(a: number, b: number): boolean {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9) <= MIN_CLUSTER_REL;
}

function hasAgreeingPair(_field: string, vals: number[]): boolean {
  for (let i = 0; i < vals.length; i++) {
    for (let j = i + 1; j < vals.length; j++) {
      if (clusterGate(vals[i]!, vals[j]!)) return true;
    }
  }
  return false;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

async function main() {
  const res = await db.execute(sql`
    SELECT field, source, ticker, value::float8 AS val
    FROM source_fundamentals
    WHERE source IN ('yahoo','finnhub','fmp','edgar','polygon','alpha_vantage','factset')
      AND value IS NOT NULL
  `);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows) ?? [];

  type Cell = { factset?: number; free: Map<string, number> };
  const cells = new Map<string, Cell>();

  for (const row of rows as { field: string; source: string; ticker: string; val: number }[]) {
    const field = String(row.field);
    const ticker = String(row.ticker).toUpperCase();
    const source = String(row.source);
    const val = Number(row.val);
    if (!Number.isFinite(val)) continue;
    const key = `${ticker}|${field}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { free: new Map() };
      cells.set(key, cell);
    }
    if (source === "factset") cell.factset = val;
    else if ((FREE_SOURCES as readonly string[]).includes(source)) cell.free.set(source, val);
  }

  const byTfField = new Map<string, { inBand: number; n: number }>();

  for (const [key, cell] of cells) {
    const [, sfField] = key.split("|") as [string, string];
    const field = tfCol(sfField);
    if (cell.factset == null || !Number.isFinite(cell.factset)) continue;
    const freeVals = [...cell.free.values()];
    if (freeVals.length < 2) continue;
    if (!hasAgreeingPair(field, freeVals)) continue;

    const med = median(freeVals);
    const inBand = factsetWithinBand(field, cell.factset, med);
    const agg = byTfField.get(field) ?? { inBand: 0, n: 0 };
    agg.n++;
    if (inBand) agg.inBand++;
    byTfField.set(field, agg);
  }

  const tableRows = [...byTfField.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([field, { n, inBand }]) => {
      const inBandShare = n > 0 ? inBand / n : 0;
      return {
        field,
        n,
        inBandShare: Math.round(inBandShare * 1000) / 1000,
        factsetRuler: inBandShare >= RULER_THRESHOLD && n >= 15,
      };
    });

  const out: RulerTable = {
    generatedAt: new Date().toISOString(),
    probeNote:
      "Cells with ≥2 free sources pairwise agreeing (10% rel for cluster gate) and FactSet present; in-band = |FactSet−median(free)| within 20%/3pp band.",
    minClusterRel: MIN_CLUSTER_REL,
    factsetBandRel: FACTSET_BAND_REL,
    rulerThreshold: RULER_THRESHOLD,
    rows: tableRows,
  };

  writeFileSync(RULER_JSON, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, path: RULER_JSON, rows: tableRows.length, rulers: tableRows.filter((r) => r.factsetRuler) }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
