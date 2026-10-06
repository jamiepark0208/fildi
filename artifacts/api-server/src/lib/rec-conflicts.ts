/**
 * Thin non-contradiction helpers across Live / Top Options / Model List.
 * Soft display only — does not mutate scores or hide ideas.
 * Model List is the trade SoT when surfaces disagree.
 */

export type RecConflictCode =
  | "live_both_sides"
  | "model_vs_live_side"
  | "model_vs_hotlist";

export type RecConflict = {
  ticker: string;
  code: RecConflictCode;
  text: string;
  /** Prefer Model List side when present */
  prefer?: "model";
  severity: "warn" | "info";
};

export type ModelSideIdea = {
  ticker: string;
  /** put | call — Model List contract type */
  side: "put" | "call";
};

export type RecConflictInput = {
  modelIdeas: ModelSideIdea[];
  liveDip: string[];
  liveRally: string[];
  liveTopPuts: string[];
  liveTopCalls: string[];
};

function up(t: string): string {
  return t.toUpperCase();
}

/** Pure conflict detection — no I/O. */
export function detectRecConflicts(input: RecConflictInput): RecConflict[] {
  const out: RecConflict[] = [];
  const dip = new Set(input.liveDip.map(up));
  const rally = new Set(input.liveRally.map(up));
  const topPuts = new Set(input.liveTopPuts.map(up));
  const topCalls = new Set(input.liveTopCalls.map(up));

  for (const t of dip) {
    if (rally.has(t)) {
      out.push({
        ticker: t,
        code: "live_both_sides",
        text: `${t}: on Live Oversold and Overbought (should be empty after RSI gate)`,
        severity: "warn",
      });
    }
  }

  for (const idea of input.modelIdeas) {
    const t = up(idea.ticker);
    if (idea.side === "put" && topCalls.has(t)) {
      out.push({
        ticker: t,
        code: "model_vs_live_side",
        text: `${t}: Model List sell-put vs Live Top Calls`,
        prefer: "model",
        severity: "warn",
      });
    }
    if (idea.side === "call" && topPuts.has(t)) {
      out.push({
        ticker: t,
        code: "model_vs_live_side",
        text: `${t}: Model List sell-call vs Live Top Puts`,
        prefer: "model",
        severity: "warn",
      });
    }
    if (idea.side === "put" && rally.has(t)) {
      out.push({
        ticker: t,
        code: "model_vs_hotlist",
        text: `${t}: Model put idea also Live Overbought`,
        prefer: "model",
        severity: "info",
      });
    }
    if (idea.side === "call" && dip.has(t)) {
      out.push({
        ticker: t,
        code: "model_vs_hotlist",
        text: `${t}: Model call idea also Live Oversold`,
        prefer: "model",
        severity: "info",
      });
    }
  }

  return out;
}

/** Lookup helper for UI chips. */
export function conflictsForTicker(
  conflicts: RecConflict[],
  ticker: string,
): RecConflict[] {
  const t = up(ticker);
  return conflicts.filter(c => c.ticker === t);
}
