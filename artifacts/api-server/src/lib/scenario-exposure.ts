/**
 * A149 — scenario exposure from OpenJev controls cache (S039).
 * Display only. File: research/openjev/controls/scenarios.jsonl (local cache).
 */
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PATH = resolve(ROOT, "research/openjev/controls/scenarios.jsonl");

/** Claude plan: drop gold/crypto (near-all neutral). */
export const SCENARIO_IDS = [
  "oil", "rates", "dollar", "china", "ai", "consumer", "housing", "credit",
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export const SCENARIO_LABELS: Record<ScenarioId, string> = {
  oil: "Oil spikes",
  rates: "Rates / yields up",
  dollar: "Dollar strengthens",
  china: "China boom",
  ai: "AI / chip spend up",
  consumer: "Consumer discretionary up",
  housing: "Housing boom",
  credit: "Credit freeze",
};

type Row = { t: string; g: string; score: Record<string, number | null> };

let cache: { mtime: number; byTicker: Map<string, Row> } | null = null;

function load(): Map<string, Row> {
  if (!existsSync(PATH)) return new Map();
  const st = readFileSync(PATH);
  // mtime via size+first bytes cheap; re-read when file grows
  const mtime = st.length;
  if (cache && cache.mtime === mtime) return cache.byTicker;
  const byTicker = new Map<string, Row>();
  for (const line of st.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Row;
      if (r?.t) byTicker.set(r.t.toUpperCase(), r);
    } catch { /* skip bad line */ }
  }
  cache = { mtime, byTicker };
  return byTicker;
}

export interface ScenarioSide {
  ticker: string;
  peerGroup: string;
  score: number;
}

export interface ScenarioExposureResponse {
  available: boolean;
  scenario: ScenarioId;
  label: string;
  /** OpenJev helped−hurt (−1…+1). Beta overlay deferred until monthly bake. */
  source: "openjev";
  note: string;
  hurt: ScenarioSide[];
  helped: ScenarioSide[];
  covered: number;
  universe: number;
}

export function getScenarioExposure(
  scenario: ScenarioId,
  bookTickers: string[],
  topN = 5,
): ScenarioExposureResponse {
  const by = load();
  const book = [...new Set(bookTickers.map((t) => t.toUpperCase()).filter(Boolean))];
  const scored: ScenarioSide[] = [];
  for (const t of book) {
    const r = by.get(t);
    const s = r?.score?.[scenario];
    if (r && typeof s === "number" && Number.isFinite(s)) {
      scored.push({ ticker: t, peerGroup: r.g, score: s });
    }
  }
  const hurt = [...scored].sort((a, b) => a.score - b.score).slice(0, topN);
  const helped = [...scored].sort((a, b) => b.score - a.score).slice(0, topN);
  return {
    available: by.size > 0,
    scenario,
    label: SCENARIO_LABELS[scenario],
    source: "openjev",
    note: "OpenJev business-description read (S039) — not a forecast. Realized betas next monthly bake.",
    hurt,
    helped,
    covered: scored.length,
    universe: by.size,
  };
}

export function parseScenarioId(raw: unknown): ScenarioId | null {
  const s = String(raw ?? "").toLowerCase();
  return (SCENARIO_IDS as readonly string[]).includes(s) ? (s as ScenarioId) : null;
}
