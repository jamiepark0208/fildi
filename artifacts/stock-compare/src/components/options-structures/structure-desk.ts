/**
 * Desk copy + blend rank for Rankings › Structures (Jamie 10-24).
 * Stance → plain "what do I do"; Score = weighted ranks of several backtest ratios.
 */

/** Turn house_view Stance/Do jargon into an action line. */
export function deskAction(
  stance: string | null | undefined,
  writtenAsOf: string | null | undefined,
): { line: string; tip: string } {
  const tip =
    `What to do on this board today. Written each weekday morning by house_view.py (daily.py) — same refresh as Model List. ` +
    `Last written: ${writtenAsOf ?? "—"}. Not a price forecast; a size / filter reminder from live IV vs history.`;
  const raw = stance?.replace(/\s+/g, " ").trim() ?? "";
  if (!raw) {
    return { line: "No morning desk note yet — wait for the weekday house_view job.", tip };
  }
  // Already plain **Do.** line from house_view — show as-is.
  if (/^(OK to sell|Be careful|Cut new put)/i.test(raw)) {
    return { line: raw, tip };
  }
  const rich = /(?:Premium rich\s*\(|look ~)([\d.]+)\s*×/i.exec(raw);
  const parts: string[] = [];
  if (/Credit wide/i.test(raw)) {
    parts.push("Cut new put size — credit markets look stressed (drawdown warning).");
  }
  if (/sell puts/i.test(raw) && rich) {
    parts.push(
      `OK to sell puts (keep ≤2 per peer group). Options look about ${rich[1]}× expensive vs how stocks usually move — you get paid more for the same risk.`,
    );
  } else if (/smaller puts/i.test(raw)) {
    parts.push("Be careful: sell smaller puts — crash odds look high vs usual.");
  } else if (/sell puts/i.test(raw)) {
    parts.push("OK to sell puts (keep ≤2 per peer group).");
  }
  if (/trim distress|estimate-cut|Skip distress/i.test(raw)) {
    parts.push("Skip distress / estimate-cut names.");
  }
  return { line: parts.length ? parts.join(" ") : raw, tip };
}

/** 0–1 percentile ranks (higher value → closer to 1). Nulls → 0. */
export function pctRanks(vals: Array<number | null | undefined>): number[] {
  const indexed = vals.map((v, i) => ({ i, v: typeof v === "number" && Number.isFinite(v) ? v : null }));
  const ok = indexed.filter((x) => x.v != null).sort((a, b) => (a.v as number) - (b.v as number));
  const out = vals.map(() => 0);
  if (!ok.length) return out;
  ok.forEach((x, rank) => {
    out[x.i] = ok.length === 1 ? 1 : rank / (ok.length - 1);
  });
  return out;
}

export type BlendInputs = {
  sharpe?: number | null;
  win?: number | null;
  mean?: number | null;
  /** worst5 is negative; we rank −worst5 so milder tails score higher */
  worst5?: number | null;
};

/**
 * Blend of backtest ratios (within the current table).
 * Weights: ret÷risk 40 · win 25 · avg return 20 · tail (milder) 15.
 */
export function blendScores(rows: BlendInputs[]): number[] {
  const rSharpe = pctRanks(rows.map((r) => r.sharpe ?? null));
  const rWin = pctRanks(rows.map((r) => r.win ?? null));
  const rMean = pctRanks(rows.map((r) => r.mean ?? null));
  const rTail = pctRanks(rows.map((r) => (r.worst5 == null ? null : -r.worst5)));
  return rows.map((_, i) => 0.4 * rSharpe[i] + 0.25 * rWin[i] + 0.2 * rMean[i] + 0.15 * rTail[i]);
}
