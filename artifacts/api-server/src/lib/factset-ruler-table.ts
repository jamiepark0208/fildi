/**
 * Per-field FactSet ruler eligibility (A318 segment 0).
 * JSON lives beside merge-trusted — one home for probe output + runtime lookup.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RULER_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/merge-trusted-factset-ruler.json",
);

export type RulerRow = {
  field: string;
  n: number;
  inBandShare: number;
  factsetRuler: boolean;
};

export type RulerTable = {
  generatedAt: string;
  probeNote: string;
  minClusterRel: number;
  factsetBandRel: number;
  rulerThreshold: number;
  rows: RulerRow[];
};

const FRACTION_FIELDS = new Set([
  "grossMargin",
  "operatingMargin",
  "netMargin",
  "returnOnEquity",
  "returnOnAssets",
  "revenueGrowthYoY",
  "revenueGrowthYoyPrior",
  "epsGrowth",
  "dividendYield",
  "tier1CapitalRatio",
  "totalCapitalRatio",
  "rotce",
]);

/** Agreement band (2026-11-02): 20% relative or 3 pp on fraction fields, whichever is wider. */
export function valuesAgreeField(field: string, a: number, b: number): boolean {
  const rel = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
  if (rel <= 0.2) return true;
  const isFraction =
    FRACTION_FIELDS.has(field) ||
    (Math.abs(a) <= 1.5 && Math.abs(b) <= 1.5 && Math.max(Math.abs(a), Math.abs(b)) < 2);
  if (isFraction && Math.abs(a - b) <= 0.03) return true;
  return false;
}

export function factsetWithinBand(field: string, factset: number, anchor: number): boolean {
  return valuesAgreeField(field, factset, anchor);
}

let cached: RulerTable | null = null;

export function loadRulerTable(path = RULER_JSON): RulerTable {
  if (cached && path === RULER_JSON) return cached;
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as RulerTable;
  if (path === RULER_JSON) cached = parsed;
  return parsed;
}

export function isFactsetRulerField(field: string, table?: RulerTable): boolean {
  const t = table ?? loadRulerTable();
  const row = t.rows.find((r) => r.field === field);
  return row?.factsetRuler === true;
}

export function factsetRulerFields(table?: RulerTable): Set<string> {
  const t = table ?? loadRulerTable();
  return new Set(t.rows.filter((r) => r.factsetRuler).map((r) => r.field));
}
