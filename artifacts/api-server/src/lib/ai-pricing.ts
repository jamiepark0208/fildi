/**
 * One home for metered LLM prices (A130). $ per million tokens, Anthropic first-party list prices
 * (claude-api skill, cached 2026-10-06). Estimates only — the Anthropic console bill is the truth.
 */
export const LLM_PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

/** Legacy rows have no model: they were all Haiku 4.5 (the only model before A130). */
export const LEGACY_MODEL = "claude-haiku-4-5";

/** Strip a date suffix (claude-haiku-4-5-20251001 → claude-haiku-4-5). */
export function priceKey(model: string | null | undefined): string {
  const m = (model ?? LEGACY_MODEL).replace(/-\d{8}$/, "");
  return m in LLM_PRICE_PER_MTOK ? m : LEGACY_MODEL;
}

export function estimateCostUsd(model: string | null | undefined, inputTokens: number, outputTokens: number): number {
  const p = LLM_PRICE_PER_MTOK[priceKey(model)];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// ── AI spend (A130): grouped ai_usage_log rows → totals + per-surface est $ ──
export interface AiSpendGroup { surfaceType: string; model: string | null; calls: number; inputTokens: number; outputTokens: number }
export interface AiSpendSummary {
  since: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estUsd: number;
  bySurface: { surfaceType: string; calls: number; estUsd: number }[];
}

/** Pure: grouped rows → totals + per-surface $ (sorted by $ desc). */
export function summarizeAiSpend(groups: AiSpendGroup[], since: string): AiSpendSummary {
  const by = new Map<string, { calls: number; estUsd: number }>();
  let calls = 0, inputTokens = 0, outputTokens = 0, estUsd = 0;
  for (const g of groups) {
    const usd = estimateCostUsd(g.model, g.inputTokens, g.outputTokens);
    calls += g.calls; inputTokens += g.inputTokens; outputTokens += g.outputTokens; estUsd += usd;
    const cur = by.get(g.surfaceType) ?? { calls: 0, estUsd: 0 };
    cur.calls += g.calls; cur.estUsd += usd;
    by.set(g.surfaceType, cur);
  }
  const bySurface = [...by.entries()].map(([surfaceType, v]) => ({ surfaceType, ...v })).sort((a, b) => b.estUsd - a.estUsd);
  return { since, calls, inputTokens, outputTokens, estUsd, bySurface };
}
