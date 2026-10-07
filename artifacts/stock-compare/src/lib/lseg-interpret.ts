/**
 * Plain-English interpretation of the LSEG research payload (GET /api/research/lseg/:ticker).
 * Pure functions — no React — so thresholds and wording are unit-testable.
 * Soft research context only; nothing here feeds fund_score.
 */

export type Tone = "good" | "bad" | "warn" | "neutral";

export type LsegSignals = {
  asOf: string;
  price: number | null;
  epsMeanFy1: number | null;
  epsDrift30dPct: number | null;
  numEst: number | null;
  fy1Period: string | null;
  recMean: number | null;
  ptMean: number | null;
  ptUpsidePct: number | null;
  predSurprisePct: number | null;
  fq1PeriodEnd: string | null;
  armRank: number | null;
  combinedAlphaRank: number | null;
  valmoRank: number | null;
  shortPct: number | null;
  shortPctFloat: number | null;
  issuerRating: string | null;
  /** StarMine Credit Combined region rank 1–100 (low = higher financial-distress risk). */
  creditRank?: number | null;
  priceMoRank?: number | null;
  relValRank?: number | null;
  priceToIntrinsic?: number | null;
  epsMeanFq1?: number | null;
  epsStdFq1?: number | null;
  numEstFq1?: number | null;
};

export type LsegEvent = { date: string; type: string; title: string | null; daysUntil: number };

export type LsegOption = {
  type: string; // "put" | "call"
  direction: string; // "short" | "long"
  strike: number | null;
  expiration: string | null;
  qty: number | null;
};

export type LsegInput = {
  signals: LsegSignals;
  nextEarnings: LsegEvent | null;
  myPosition: { shares: number | null; options: LsegOption[] } | null;
  /** From lib/lseg-earnings.ts: is the premium through the next report rich/fair/cheap. */
  premium?: { verdict: "rich" | "fair" | "cheap"; tone: Tone; text: string } | null;
  /** From lib/lseg-earnings.ts dispersionNote. */
  dispersion?: { tone: Tone; text: string } | null;
  /** From lib/lseg-earnings.ts earningsHistoryNote — used when no rich/cheap verdict is possible yet. */
  historyNote?: { text: string } | null;
  /** Top-10 holders (lseg_research.holders_top). */
  topHolders?: Holder[];
};

export type Holder = {
  rank: number;
  investor: string;
  type: string | null;
  pctOut: number | null;
  changeShares: number | null;
  filingDate: string | null;
};

export const HOLDERS_ADDING = 7; // of top 10
export const HOLDERS_TRIMMING = 6;
export const BLOCK_HOLDER_PCT = 5;

/** Ownership concentration + who's adding/trimming + single holders big enough to move the stock if they sell. */
export function ownershipSummary(holders: Holder[]) {
  if (!holders.length) return null;
  const top10Pct = holders.reduce((a, h) => a + (h.pctOut ?? 0), 0);
  const adding = holders.filter((h) => (h.changeShares ?? 0) > 0).length;
  const trimming = holders.filter((h) => (h.changeShares ?? 0) < 0).length;
  const blocks = holders.filter(
    (h) => (h.pctOut ?? 0) >= BLOCK_HOLDER_PCT && /private equity|corporation|individual|strategic|venture/i.test(h.type ?? ""),
  );
  return { top10Pct, adding, trimming, n: holders.length, blocks };
}

export type Takeaway = { tone: Tone; title: string; detail: string };

export type SignalRow = {
  key: string;
  label: string;
  value: string;
  tone: Tone;
  /** 1–100 StarMine rank for a gauge; null = no gauge. */
  gauge: number | null;
  meaning: string;
};

export type Interpretation = {
  verdict: { tone: Tone; text: string };
  coverage: "none" | "thin" | "ok";
  takeaways: Takeaway[];
  rows: SignalRow[];
};

/** StarMine treats |predicted surprise| ≥ 2% as a meaningful beat/miss call. */
export const PRED_SURPRISE_SIGNAL = 2;
export const RANK_HIGH = 70;
export const RANK_LOW = 30;
export const SHORT_HEAVY = 20;
export const SHORT_ELEVATED = 10;
/** Small-cap targets this far above price are aggressive; past PT_IMPLAUSIBLE they're almost always stale. */
export const PT_AGGRESSIVE = 150;
export const PT_IMPLAUSIBLE = 300;
export const THIN_COVERAGE = 5;
/** StarMine credit rank at/below this = meaningfully elevated distress risk (bottom fifth). */
export const CREDIT_WEAK = 20;
export const CREDIT_SEVERE = 10;

const pct = (v: number, d = 1) => `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;

export function rankPhrase(rank: number): string {
  return rank >= 50 ? `top ${Math.max(1, 101 - rank)}%` : `bottom ${rank}%`;
}

export function rankTone(rank: number | null): Tone {
  if (rank == null) return "neutral";
  if (rank >= RANK_HIGH) return "good";
  if (rank <= RANK_LOW) return "bad";
  return "neutral";
}

export function recLabel(rec: number): string {
  if (rec <= 1.5) return "Strong Buy";
  if (rec <= 2.5) return "Buy";
  if (rec <= 3.5) return "Hold";
  if (rec <= 4.5) return "Sell";
  return "Strong Sell";
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Which of your short options are still open on earnings day (exposed) vs expire before it. */
export function earningsExposure(options: LsegOption[], earningsDate: string) {
  const shorts = options.filter((o) => o.direction === "short" && o.expiration);
  return {
    exposed: shorts.filter((o) => o.expiration! >= earningsDate),
    clear: shorts.filter((o) => o.expiration! < earningsDate),
  };
}

function holdingPhrase(shares: number, shortPuts: number): string {
  const parts = [shares > 0 ? `your ${shares.toLocaleString("en-US")} shares` : "", shortPuts ? "your short puts" : ""].filter(Boolean);
  return parts.length ? ` for ${parts.join(" and ")}` : "";
}

function describeOpt(o: LsegOption): string {
  const q = o.qty ?? 1;
  return `${q} ${o.type}${q === 1 ? "" : "s"} $${o.strike ?? "?"} exp ${o.expiration ? fmtDate(o.expiration) : "?"}`;
}

export function interpretLseg(input: LsegInput): Interpretation {
  const s = input.signals;
  const n = s.numEst ?? 0;
  const coverage: Interpretation["coverage"] = n === 0 ? "none" : n < THIN_COVERAGE ? "thin" : "ok";
  const takeaways: Takeaway[] = [];
  const rows: SignalRow[] = [];
  const shorts = input.myPosition?.options.filter((o) => o.direction === "short") ?? [];
  const shortPuts = shorts.filter((o) => o.type === "put");
  const shortCalls = shorts.filter((o) => o.type === "call");
  const ps = s.predSurprisePct;
  const psCall = ps == null ? null : ps >= PRED_SURPRISE_SIGNAL ? "beat" : ps <= -PRED_SURPRISE_SIGNAL ? "miss" : "inline";

  // ── Earnings + your options ────────────────────────────────────────────────
  const ne = input.nextEarnings;
  if (ne) {
    const when = `${fmtDate(ne.date)} (in ${ne.daysUntil}d)`;
    const lean =
      psCall === "beat"
        ? `StarMine leans BEAT (${pct(ps!, 1)} vs consensus).`
        : psCall === "miss"
          ? `StarMine leans MISS (${pct(ps!, 1)} vs consensus).`
          : psCall === "inline"
            ? "StarMine expects roughly in line with consensus."
            : "No StarMine prediction available.";
    const typical = !input.premium && input.historyNote ? ` ${input.historyNote.text}` : "";
    const { exposed, clear } = earningsExposure(shorts, ne.date);
    if (exposed.length) {
      const putsExposed = exposed.some((o) => o.type === "put");
      const callsExposed = exposed.some((o) => o.type === "call");
      const danger = (putsExposed && psCall === "miss") || (callsExposed && psCall === "beat");
      takeaways.push({
        tone: danger ? "bad" : "warn",
        title: `Earnings ${when} hits your open options`,
        detail:
          `${exposed.map(describeOpt).join(", ")} ${exposed.length === 1 && (exposed[0].qty ?? 1) === 1 ? "is" : "are"} still open on report day. ${lean}${typical}` +
          (danger
            ? putsExposed && psCall === "miss"
              ? " A miss usually gaps the stock down, which pushes short puts toward assignment."
              : " A beat can gap the stock up through your short call strike."
            : " Expect a bigger-than-usual move either way."),
      });
    } else if (shorts.length && clear.length) {
      takeaways.push({
        tone: "good",
        title: `Earnings ${when}, after your options expire`,
        detail: `${clear.map(describeOpt).join(", ")} expire${clear.length === 1 && (clear[0].qty ?? 1) === 1 ? "s" : ""} before the report, so this print doesn't affect them. ${lean}`,
      });
    } else if (ne.daysUntil <= 21) {
      takeaways.push({
        tone: psCall === "miss" ? "bad" : psCall === "beat" ? "good" : "neutral",
        title: `Earnings ${when}`,
        detail: `${lean}${typical} Options expiring after ${fmtDate(ne.date)} will carry earnings risk and richer premium.`,
      });
    }
  } else if (psCall === "miss" || psCall === "beat") {
    takeaways.push({
      tone: psCall === "beat" ? "good" : "bad",
      title: `StarMine leans ${psCall.toUpperCase()} next quarter`,
      detail: `Predicted surprise ${pct(ps!, 1)} vs consensus. No report date in the next 60 days yet.`,
    });
  }

  if (input.premium) {
    takeaways.push({
      tone: input.premium.tone,
      title: `Earnings premium looks ${input.premium.verdict.toUpperCase()}`,
      detail: input.premium.text,
    });
  }
  if (input.dispersion) {
    takeaways.push({ tone: input.dispersion.tone, title: "Analysts disagree on next quarter", detail: input.dispersion.text });
  }

  // ── Analyst revisions (ARM) ────────────────────────────────────────────────
  if (s.armRank != null && coverage !== "none") {
    if (s.armRank >= RANK_HIGH)
      takeaways.push({
        tone: "good",
        title: "Analysts are raising their numbers",
        detail: `Revision momentum ranks in the ${rankPhrase(s.armRank)} of North American stocks. Rising estimates tend to support the price over the next few months.`,
      });
    else if (s.armRank <= RANK_LOW)
      takeaways.push({
        tone: "bad",
        title: "Analysts are cutting their numbers",
        detail: `Revision momentum ranks in the ${rankPhrase(s.armRank)}. Falling estimates are a headwind${holdingPhrase(input.myPosition?.shares ?? 0, shortPuts.length)}.`,
      });
  }

  // ── Credit / distress risk ─────────────────────────────────────────────────
  if (s.creditRank != null && s.creditRank <= CREDIT_WEAK) {
    const severe = s.creditRank <= CREDIT_SEVERE;
    takeaways.push({
      tone: "bad",
      title: `${severe ? "High" : "Elevated"} financial-distress risk (credit ${s.creditRank}/100)`,
      detail:
        `StarMine's credit model ranks it in the ${rankPhrase(s.creditRank)} of North American companies for balance-sheet health. ` +
        (shortPuts.length
          ? "For your short puts this is the tail risk: being assigned on a company that may need to raise cash (dilution) or restructure. Keep size small and strikes wide."
          : "If you sell puts here, that's the tail risk: assignment on a company that may need to raise cash (dilution). Size small, strikes wide."),
    });
  }

  // ── Ownership ──────────────────────────────────────────────────────────────
  const own = ownershipSummary(input.topHolders ?? []);
  if (own) {
    if (own.adding >= HOLDERS_ADDING)
      takeaways.push({
        tone: "good",
        title: `Big holders are adding (${own.adding} of top ${own.n})`,
        detail: "Most of the largest shareholders increased their stakes in their latest filings. Institutions are accumulating, not heading for the exit.",
      });
    else if (own.trimming >= HOLDERS_TRIMMING)
      takeaways.push({
        tone: "warn",
        title: `Big holders are trimming (${own.trimming} of top ${own.n})`,
        detail: "Most of the largest shareholders cut their stakes in their latest filings. That's steady supply that can cap rallies.",
      });
    for (const b of own.blocks.slice(0, 2)) {
      const pe = /private equity|venture/i.test(b.type ?? "");
      takeaways.push({
        tone: pe ? "warn" : "neutral",
        title: `${b.type ?? "Large holder"} owns ${b.pctOut!.toFixed(1)}%`,
        detail: pe
          ? `${b.investor} is a private-equity/venture holder. These eventually sell (lockup expiries, fund exits), and a block that size can gap the stock down.`
          : `${b.investor} holds a strategic/insider-type block. It's usually sticky, but any sale would be a big supply event.`,
      });
    }
  }

  // ── Crowding ───────────────────────────────────────────────────────────────
  const sf = s.shortPctFloat ?? s.shortPct;
  if (sf != null && sf >= SHORT_HEAVY) {
    takeaways.push({
      tone: "warn",
      title: `Heavily shorted: ${sf.toFixed(0)}% of float`,
      detail:
        "Lots of traders are betting against it. That means violent moves both ways (squeezes up, air pockets down). It's also why premiums stay rich, so size short puts for a gap.",
    });
  }

  // ── Price target sanity ────────────────────────────────────────────────────
  if (s.ptUpsidePct != null && s.ptUpsidePct > PT_AGGRESSIVE) {
    const mult = (1 + s.ptUpsidePct / 100).toFixed(1);
    takeaways.push(
      s.ptUpsidePct > PT_IMPLAUSIBLE
        ? {
            tone: "warn",
            title: "Analyst price target looks unreliable",
            detail: `The average target is ${mult}× the current price. That's usually stale targets (e.g. from before a reverse split) or abandoned coverage. Ignore it.`,
          }
        : {
            tone: "warn",
            title: "Analyst targets are very aggressive",
            detail: `The average target is ${mult}× the current price. Small-cap targets are often set high and updated slowly, so don't treat it as a fair-value anchor.`,
          },
    );
  }

  if (coverage === "thin") {
    takeaways.push({
      tone: "neutral",
      title: `Only ${n} analyst${n === 1 ? "" : "s"} cover this`,
      detail: "With so few estimates, one analyst changing their view moves every number here. Treat these as weak signals.",
    });
  }

  // ── Signal rows ────────────────────────────────────────────────────────────
  const rankRow = (key: string, label: string, rank: number | null, what: string) => {
    if (rank == null) return;
    rows.push({
      key,
      label,
      value: `${rank}/100`,
      tone: rankTone(rank),
      gauge: rank,
      meaning: `${rankPhrase(rank)} of NA stocks: ${what}`,
    });
  };
  rankRow("arm", "Analyst revisions", s.armRank, "how fast analysts are raising (or cutting) estimates and ratings.");
  rankRow("cam", "Overall LSEG score", s.combinedAlphaRank, "blend of value, quality, momentum and analyst signals, built to predict 12-month relative return.");
  rankRow("valmo", "Value + momentum", s.valmoRank, "cheap stocks that are also trending up score high.");

  if (ps != null)
    rows.push({
      key: "ps",
      label: "Predicted surprise",
      value: pct(ps, 2),
      tone: psCall === "beat" ? "good" : psCall === "miss" ? "bad" : "neutral",
      gauge: null,
      meaning:
        `StarMine's estimate (weighting the most accurate analysts) vs the plain average for next quarter. ` +
        `Beyond ±${PRED_SURPRISE_SIGNAL}% is a real lean; inside it is noise.`,
    });

  if (s.epsDrift30dPct != null)
    rows.push({
      key: "drift",
      label: "EPS estimate, 30d",
      value: pct(s.epsDrift30dPct, 2),
      tone: s.epsDrift30dPct >= 1 ? "good" : s.epsDrift30dPct <= -1 ? "bad" : "neutral",
      gauge: null,
      meaning: `Change in the ${s.fy1Period ?? "this-year"} EPS consensus (${s.epsMeanFy1?.toFixed(2) ?? "—"}) over the last 30 days.`,
    });

  if (s.ptMean != null && s.ptUpsidePct != null)
    rows.push({
      key: "pt",
      label: "Avg price target",
      value: `$${s.ptMean.toFixed(s.ptMean < 10 ? 2 : 0)} (${pct(s.ptUpsidePct, 0)})`,
      tone: s.ptUpsidePct > PT_AGGRESSIVE ? "warn" : s.ptUpsidePct >= 15 ? "good" : s.ptUpsidePct < 0 ? "bad" : "neutral",
      gauge: null,
      meaning:
        s.ptUpsidePct > PT_IMPLAUSIBLE
          ? "Implausibly far from price, likely stale."
          : s.ptUpsidePct > PT_AGGRESSIVE
            ? "Very aggressive; take with a grain of salt."
            : s.ptUpsidePct < 0
            ? "Trading above where analysts think it's worth."
            : "Where analysts think the stock goes in 12 months.",
    });

  if (s.recMean != null)
    rows.push({
      key: "rec",
      label: "Analyst rating",
      value: `${recLabel(s.recMean)} (${s.recMean.toFixed(1)})`,
      tone: s.recMean <= 2 ? "good" : s.recMean >= 3.5 ? "bad" : "neutral",
      gauge: null,
      meaning: `Average of ${n || "?"} analysts on a 1 (Strong Buy) to 5 (Strong Sell) scale.`,
    });

  if (sf != null)
    rows.push({
      key: "short",
      label: "Short interest",
      value: `${sf.toFixed(1)}% of float`,
      tone: sf >= SHORT_HEAVY ? "warn" : "neutral",
      gauge: null,
      meaning:
        sf >= SHORT_HEAVY
          ? "Very crowded short. Squeeze and gap risk."
          : sf >= SHORT_ELEVATED
            ? "Elevated. More traders betting against it than usual."
            : "Normal.",
    });

  if (s.creditRank != null)
    rows.push({
      key: "credit",
      label: "Credit health",
      value: `${s.creditRank}/100`,
      tone: s.creditRank <= CREDIT_WEAK ? "bad" : s.creditRank >= 70 ? "good" : "neutral",
      gauge: s.creditRank,
      meaning: `${rankPhrase(s.creditRank)} of NA companies on StarMine's default-risk model (debt, cash burn, market and text signals). Low = fragile.`,
    });

  if (own)
    rows.push({
      key: "owners",
      label: "Top-10 ownership",
      value: `${own.top10Pct.toFixed(0)}% of shares`,
      tone: own.adding >= HOLDERS_ADDING ? "good" : own.trimming >= HOLDERS_TRIMMING ? "warn" : "neutral",
      gauge: null,
      meaning: `${own.adding} of the top ${own.n} added, ${own.trimming} trimmed in their latest filings. Higher concentration means fewer, bigger hands.`,
    });

  if (s.issuerRating)
    rows.push({
      key: "rating",
      label: "Credit rating",
      value: s.issuerRating,
      tone: "neutral",
      gauge: null,
      meaning: "Company debt rating. Higher (AAA/Aaa) means a stronger balance sheet.",
    });

  // ── Verdict ────────────────────────────────────────────────────────────────
  let verdict: Interpretation["verdict"];
  if (coverage === "none") {
    verdict = {
      tone: "neutral",
      text: "No analyst coverage. LSEG has no estimates for this (common for ETFs and micro-caps).",
    };
  } else {
    const votes = [
      rankTone(s.armRank),
      rankTone(s.combinedAlphaRank),
      psCall === "beat" ? "good" : psCall === "miss" ? "bad" : "neutral",
      s.epsDrift30dPct == null ? "neutral" : s.epsDrift30dPct >= 1 ? "good" : s.epsDrift30dPct <= -1 ? "bad" : "neutral",
    ] as Tone[];
    const good = votes.filter((v) => v === "good").length;
    const bad = votes.filter((v) => v === "bad").length;
    const reasons: string[] = [];
    if (s.armRank != null && s.armRank >= RANK_HIGH) reasons.push("estimates rising");
    if (s.armRank != null && s.armRank <= RANK_LOW) reasons.push("estimates being cut");
    if (s.combinedAlphaRank != null && s.combinedAlphaRank >= RANK_HIGH) reasons.push("strong overall LSEG score");
    if (s.combinedAlphaRank != null && s.combinedAlphaRank <= RANK_LOW) reasons.push("weak overall LSEG score");
    if (psCall === "beat") reasons.push("StarMine leans beat");
    if (psCall === "miss") reasons.push("StarMine leans miss");
    const why = reasons.length ? `: ${reasons.join(", ")}` : "";
    const net = good - bad;
    verdict =
      net >= 2
        ? { tone: "good", text: `Street momentum is positive${why}.` }
        : net <= -2
          ? { tone: "bad", text: `Street momentum is negative${why}.` }
          : net === 1 && good >= 2
            ? { tone: "good", text: `Leaning positive${why}.` }
            : net === -1 && bad >= 2
              ? { tone: "bad", text: `Leaning negative${why}.` }
              : good + bad === 0
                ? { tone: "neutral", text: "Nothing stands out. Analyst signals are middle-of-the-pack." }
                : { tone: "warn", text: `Mixed signals${why}.` };
    if (coverage === "thin") verdict.text += ` (thin coverage: ${n} analyst${n === 1 ? "" : "s"})`;
  }

  const order: Record<Tone, number> = { bad: 0, warn: 1, good: 2, neutral: 3 };
  takeaways.sort((a, b) => order[a.tone] - order[b.tone]);
  return { verdict, coverage, takeaways, rows };
}

// ── Trade lenses (same three questions as the WRDS panel: puts / calls / directional) ──

export type TradeHints = { put: { tone: Tone; text: string }; call: { tone: Tone; text: string }; directional: string };

export function tradeHints(input: LsegInput, interp: Interpretation): TradeHints {
  if (interp.coverage === "none") {
    return {
      put: { tone: "neutral", text: "No Street data. Pick strikes from fund/tech scores and IV alone." },
      call: { tone: "neutral", text: "No Street data. Pick strikes from fund/tech scores and IV alone." },
      directional: "No directional edge from LSEG.",
    };
  }
  const s = input.signals;
  const ne = input.nextEarnings;
  const erSoon = ne != null && ne.daysUntil <= 30;
  const erNote = ne ? ` Earnings ${ne.date}: expiries after that carry gap risk.` : "";
  const ps = s.predSurprisePct;
  const leanMiss = ps != null && ps <= -PRED_SURPRISE_SIGNAL;
  const leanBeat = ps != null && ps >= PRED_SURPRISE_SIGNAL;
  const crowded = (s.shortPctFloat ?? s.shortPct ?? 0) >= SHORT_HEAVY;
  const v = interp.verdict.tone;

  let put: TradeHints["put"];
  if (v === "bad" || (leanMiss && erSoon))
    put = { tone: "bad", text: `Caution: Street is turning down. Go further OTM, smaller size, or expire before the report.${erNote}` };
  else if (v === "good")
    put = { tone: "good", text: `Supportive: rising estimates help a dip get bought.${erNote}` };
  else put = { tone: "neutral", text: `No clear Street edge. Lean on fund/tech scores for strikes.${erNote}` };
  if (crowded) put.text += " Heavy short interest means rich premium but big gaps, so size for it.";

  let call: TradeHints["call"];
  if (v === "good" || (leanBeat && erSoon))
    call = { tone: "warn", text: `Caution near the money: positive momentum${leanBeat ? " and a predicted beat" : ""} can run through strikes. Go further OTM.${erNote}` };
  else if (v === "bad")
    call = { tone: "good", text: `Supportive for covered calls: weak Street momentum makes a breakout less likely.${erNote}` };
  else call = { tone: "neutral", text: `No clear Street edge. Use overbought timing for call strikes.${erNote}` };
  if (crowded && v !== "bad") call.text += " Crowded short: squeezes can blow through call strikes.";

  const directional =
    v === "good"
      ? "Street supports a long lean only if the price is oversold (check Technical)."
      : v === "bad"
        ? "Street supports a short/fade lean only if the price is overbought (check Technical)."
        : "No directional edge. Wait for an outlier move.";
  return { put, call, directional };
}

/**
 * Loop E: does WRDS IBES history agree with today's LSEG read?
 * They measure different things (IBES revision history vs StarMine forward model),
 * so disagreement is informative — do not collapse LSEG "warn"/mixed into "neutral".
 */
export function crossCheck(lsegTone: Tone, wrdsVerdict: "supportive" | "neutral" | "caution" | null | undefined) {
  if (!wrdsVerdict) return null;
  const lsegLabel =
    lsegTone === "good" ? "supportive" : lsegTone === "bad" ? "caution" : lsegTone === "warn" ? "mixed" : "neutral";
  const aligned =
    (wrdsVerdict === "supportive" && lsegTone === "good") ||
    (wrdsVerdict === "caution" && lsegTone === "bad") ||
    (wrdsVerdict === "neutral" && (lsegTone === "neutral" || lsegTone === "warn"));
  if (aligned && lsegTone !== "warn") {
    return {
      tone: "good" as Tone,
      text: `WRDS IBES history agrees (${wrdsVerdict}). Two independent reads — higher confidence.`,
    };
  }
  if (wrdsVerdict === "supportive" && (lsegTone === "bad" || lsegTone === "warn")) {
    return {
      tone: "warn" as Tone,
      text: `WRDS says supportive (often a beat streak / SUE) while LSEG is ${lsegLabel} (forward StarMine ranks). History can look fine while the model turns — trust LSEG more for "what's next."`,
    };
  }
  if (wrdsVerdict === "caution" && (lsegTone === "good" || lsegTone === "warn")) {
    return {
      tone: "warn" as Tone,
      text: `WRDS is cautious on IBES revisions while LSEG is ${lsegLabel}. Cuts may be priced; check whether StarMine still sees a path.`,
    };
  }
  return {
    tone: "neutral" as Tone,
    text: `WRDS IBES reads ${wrdsVerdict}; LSEG reads ${lsegLabel}. Different questions (history vs forward model) — open each tab for the evidence.`,
  };
}
