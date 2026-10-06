/**
 * Deterministic WRDS research report — evidence, glossary, quantified trade lens.
 * UI should prefer these builders over server putHint/callHint/directionalHint strings.
 */

import {
  fmtRelHint,
  peerGroupLabel,
  peerHowToUse,
  relTone,
  type PeerRelativeBlock,
  type RelChip,
} from "./research-peers";

export type WrdsVerdict = "supportive" | "neutral" | "caution";
export type { PeerRelativeBlock };

export type WrdsTech = {
  iv: number | null; // ATM put IV %, e.g. 22 = 22%
  rv: number | null;
  weeklyMove?: number | null; // implied weekly move % if present
  price: number | null;
};

export type WrdsPayload = {
  ticker: string;
  oftic?: string;
  ids?: { ibesOftic: string | null; crspPermno: number | null; cusip: string | null };
  available: boolean;
  reason: string | null;
  verdict: WrdsVerdict;
  headline: string;
  putHint: string;
  callHint: string;
  directionalHint: string;
  streetEventRisk: boolean;
  consensus: {
    asOf: string | null;
    fiscalp?: string | null;
    fpi?: string | null;
    breadth: number | null;
    sue: number | null;
    numup: number | null;
    numdown: number | null;
    numest: number | null;
    meanest: number | null;
    medest?: number | null;
    meanDriftPct?: number | null;
  } | null;
  fundImpact: {
    fundTotalScore: number | null;
    fundGrowthScore: number | null;
    scoredAt: string | null;
    note: string;
  } | null;
  revisionSeries?: {
    statpers: string | null;
    meanest: number | null;
    medest: number | null;
    numest: number | null;
    numup: number | null;
    numdown: number | null;
    breadth: number | null;
    fiscalp: string | null;
    fpi: string | null;
  }[];
  surprises?: {
    anndats: string | null;
    actual: number | null;
    surpmean: number | null;
    sue: number | null;
  }[];
  finratio?: {
    asOf: string | null;
    pe: number | null;
    bm: number | null;
    roe: number | null;
    roa: number | null;
    deRatio: number | null;
    currRatio: number | null;
  } | null;
  tech?: WrdsTech | null;
  peers?: PeerRelativeBlock | null;
  sync?: Record<string, { watermark: string | null; lastOkAt: string | Date | null; lastRows: number | null }>;
  source?: string;
};

export type Evidence = {
  claim: string;
  proof: string;
  tone: "good" | "bad" | "warn" | "neutral";
};

export function fmt(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(d);
}

export function fmtPct(n: number | null | undefined, d = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(d)}%`;
}

const VERDICT_CLASS: Record<WrdsVerdict, string> = {
  supportive: "border-green-500/40 bg-green-500/10 text-green-300",
  neutral: "border-zinc-500/40 bg-zinc-800/80 text-zinc-300",
  caution: "border-red-500/40 bg-red-500/10 text-red-300",
};

export function wrdsVerdictClass(v: WrdsVerdict): string {
  return VERDICT_CLASS[v];
}

/** Plain-language glossary — shown once in the report. */
export const WRDS_GLOSSARY: { term: string; def: string }[] = [
  {
    term: "IBES",
    def: "Institutional Brokers’ Estimate System — sell-side EPS consensus history on WRDS. Not Yahoo ratings. We cache statsum (raises/cuts + mean) and surpsum (actual vs estimate).",
  },
  {
    term: "Breadth",
    def: "(numup − numdown) / numest. Why: tells if the revision is a crowd move vs one house. ≥ +0.08 supportive, ≤ −0.08 caution. Feeds fund growth (weight 1.5).",
  },
  {
    term: "SUE",
    def: "Standardized Unexpected Earnings = (actual − consensus) / σ. Why: beat/miss streak quality. Avg ≤4 prints. ≥ +0.5 beat streak; ≤ −0.5 miss streak. Feeds fund growth (weight 1.0).",
  },
  {
    term: "Growth leg",
    def: "Family inside fund_total_score. IBES extras + Yahoo growth → peer-z → fund growth → fund total → options stockQuality. Null IBES = coverage shrink, no penalty.",
  },
  {
    term: "vs Wall St. Consensus",
    def: "Sentiment’s buy/hold/sell bar is Yahoo/FMP opinion stock. IBES is estimate-path history. A name can stay Buy while estimates are cut — that is why both panels exist.",
  },
];

/** 1-week 1σ move from annualized IV (%). */
export function weeklySigmaPct(ivPct: number | null): number | null {
  if (ivPct == null || !(ivPct > 0)) return null;
  return ivPct * Math.sqrt(7 / 365);
}

/** Rough “premium per unit buffer” read for short premium. */
export function premiumBufferNote(ivPct: number | null, ticker: string): {
  tone: "good" | "warn" | "neutral";
  title: string;
  text: string;
} | null {
  const w = weeklySigmaPct(ivPct);
  if (ivPct == null || w == null) return null;
  if (ivPct < 25) {
    return {
      tone: "warn",
      title: "Thin premium vs buffer",
      text:
        `${ticker} ATM put IV ≈ ${ivPct.toFixed(0)}% → ~${w.toFixed(1)}% 1-week 1σ. ` +
        `Names this quiet (AAPL-like) pay little premium per % you step OTM — Street support does not make short puts “good economics.” Prefer richer-IV underlyers or accept tiny credit for the buffer you want.`,
    };
  }
  if (ivPct >= 40) {
    return {
      tone: "good",
      title: "Richer premium for buffer",
      text:
        `ATM put IV ≈ ${ivPct.toFixed(0)}% → ~${w.toFixed(1)}% 1-week 1σ. ` +
        `You can usually step further OTM and still collect meaningful credit vs a low-IV mega-cap. Still size for gap risk if ER is near.`,
    };
  }
  return {
    tone: "neutral",
    title: "Mid IV — check strike math",
    text:
      `ATM put IV ≈ ${ivPct.toFixed(0)}% → ~${w.toFixed(1)}% 1-week 1σ. ` +
      `Compare credit received vs % OTM on the chain before treating Street as a green light.`,
  };
}

function priorMean(data: WrdsPayload): number | null {
  const series = data.revisionSeries ?? [];
  if (series.length < 2) return null;
  // series is chronological; last = latest
  return series[series.length - 2]?.meanest ?? null;
}

export function buildWrdsEvidence(data: WrdsPayload): Evidence[] {
  const out: Evidence[] = [];
  const c = data.consensus;
  if (!data.available || !c) {
    out.push({
      claim: "No IBES cache to evaluate",
      proof: data.reason ?? "Run sync_ibes for this ticker.",
      tone: "neutral",
    });
    return out;
  }

  const prev = priorMean(data);
  if (c.meanest != null && prev != null && c.meanDriftPct != null) {
    const dir = c.meanDriftPct >= 0 ? "up" : "down";
    out.push({
      claim: `FY1 consensus mean revised ${dir}: $${fmt(prev)} → $${fmt(c.meanest)} (${fmtPct(c.meanDriftPct)})`,
      proof: `Latest statsum ${c.asOf ?? "—"} vs prior period in revisionSeries (fiscalp=${c.fiscalp ?? "—"}, fpi=${c.fpi ?? "—"}).`,
      tone: c.meanDriftPct >= 1 ? "good" : c.meanDriftPct <= -1 ? "bad" : "neutral",
    });
  } else if (c.meanest != null) {
    out.push({
      claim: `Latest FY1 mean estimate is $${fmt(c.meanest)}`,
      proof: `As of ${c.asOf ?? "—"}; prior period unavailable to compute drift.`,
      tone: "neutral",
    });
  }

  if (c.breadth != null) {
    const pct = (c.breadth * 100).toFixed(0);
    const br = data.peers?.metrics?.breadth;
    const rel = fmtRelHint(br);
    out.push({
      claim: `Revision breadth ${fmt(c.breadth)} (${c.breadth >= 0 ? "+" : ""}${pct} net up vs down)${rel ? ` · ${rel}` : ""}`,
      proof: `numup=${c.numup ?? "—"}, numdown=${c.numdown ?? "—"}, numest=${c.numest ?? "—"} → (up−down)/n. Absolute rule: ≥0.08 supportive, ≤−0.08 caution.${
        br?.peerMedian != null ? ` Peer median ${fmt(br.peerMedian)} (${peerGroupLabel(data.peers)}).` : ""
      }`,
      tone: rel ? relTone(br?.peerPct ?? null) : c.breadth >= 0.08 ? "good" : c.breadth <= -0.08 ? "bad" : "neutral",
    });
  }

  if (c.sue != null) {
    const surps = (data.surprises ?? []).filter((s) => s.sue != null).slice(0, 4);
    const trail = surps.map((s) => `${s.anndats ?? "?"}:${fmt(s.sue)}`).join(", ");
    const sueM = data.peers?.metrics?.sue;
    const rel = fmtRelHint(sueM);
    out.push({
      claim: `Avg SUE ${fmt(c.sue)} over last ${Math.min(4, surps.length || 4)} surprises${rel ? ` · ${rel}` : ""}`,
      proof: trail
        ? `Trail: ${trail}. SUE = (actual−consensus)/σ. Absolute: ≥0.5 beat / ≤−0.5 miss.${
            sueM?.peerMedian != null ? ` Peer median ${fmt(sueM.peerMedian)}.` : ""
          }`
        : `From ibes_surpsum suescore average. Absolute: ≥0.5 / ≤−0.5.`,
      tone: rel ? relTone(sueM?.peerPct ?? null) : c.sue >= 0.5 ? "good" : c.sue <= -0.5 ? "bad" : "neutral",
    });
  }

  if (data.streetEventRisk) {
    out.push({
      claim: "Street-event risk flag is ON",
      proof: "Triggered when |breadth| or |SUE| is extreme (same helper as options scanner ER haircut). Expect a slightly stricter soft haircut on both put and call sides when ER ≤7d.",
      tone: "warn",
    });
  }

  const fi = data.fundImpact;
  if (fi?.fundGrowthScore != null || fi?.fundTotalScore != null) {
    out.push({
      claim: `Persisted scores — growth ${fmt(fi.fundGrowthScore, 1)} / total ${fmt(fi.fundTotalScore, 1)}`,
      proof:
        `ibesRevBreadth (w=1.5) + ibesFwdGrowth (w=2.5, FY1→FY2) sit inside the growth family (ibesSue w=0) with other growth metrics, peer-z’d, then rolled into fund_total_score (feeds options stockQuality). ` +
        `These numbers are after last rescore${fi.scoredAt ? ` (${String(fi.scoredAt).slice(0, 10)})` : ""} — not a live recompute in this panel.`,
      tone: "neutral",
    });
  }

  return out;
}

export type TradeLens = {
  side: "puts" | "calls";
  stance: "supported" | "cautious" | "neutral";
  headline: string;
  bullets: string[];
};

export function buildWrdsTradeLens(data: WrdsPayload, tech?: WrdsTech | null): TradeLens[] {
  const c = data.consensus;
  const iv = tech?.iv ?? data.tech?.iv ?? null;
  const buf = premiumBufferNote(iv, data.ticker);
  const v = data.verdict;

  const putBullets: string[] = [];
  const callBullets: string[] = [];

  if (!data.available || !c) {
    return [
      {
        side: "puts",
        stance: "neutral",
        headline: "No IBES evidence — don’t use Street for put selection",
        bullets: ["Score path ignores missing IBES (coverage shrink). Use fund/tech + chain credits only."],
      },
      {
        side: "calls",
        stance: "neutral",
        headline: "No IBES evidence for call sells",
        bullets: ["Same — nothing to add beyond IV and overbought timing."],
      },
    ];
  }

  // Puts
  if (v === "supportive") {
    putBullets.push(
      `Evidence: breadth ${fmt(c.breadth)}, avg SUE ${fmt(c.sue)}, mean ${fmtPct(c.meanDriftPct)} — underlyer quality / growth leg is helped, which lifts stockQuality after rescore.`,
    );
    putBullets.push(
      `That is NOT a signal that short-put credit is attractive. It only says the Street tape isn’t fighting a dip-buy thesis.`,
    );
  } else if (v === "caution") {
    putBullets.push(
      `Evidence: breadth ${fmt(c.breadth)}, avg SUE ${fmt(c.sue)} — growth leg softens; be pickier on assignment risk if you still sell puts.`,
    );
  } else {
    putBullets.push(`Street mixed (breadth ${fmt(c.breadth)}, SUE ${fmt(c.sue)}) — no incremental put edge from IBES.`);
  }
  if (buf) putBullets.push(buf.text);
  if (data.streetEventRisk) {
    putBullets.push("ER street-risk flag on → slightly stricter options haircut; prefer expiries before the print or wider OTM.");
  }

  // Calls
  if (v === "supportive") {
    callBullets.push(
      `Positive revisions (mean ${fmtPct(c.meanDriftPct)}, breadth ${fmt(c.breadth)}) raise upside follow-through risk into short calls — especially near ATM.`,
    );
    callBullets.push(`Fund quality may look better, but that’s not a covered-call green light; it’s a reason to respect upside.`);
  } else if (v === "caution") {
    callBullets.push(
      `Negative Street (breadth ${fmt(c.breadth)}, SUE ${fmt(c.sue)}) reduces a bit of breakout risk for covered calls — still check IV crush / ER calendar.`,
    );
  } else {
    callBullets.push(`No clear call-sell edge from IBES alone.`);
  }
  if (iv != null) {
    callBullets.push(`ATM IV ${iv.toFixed(0)}% → weekly 1σ ~${fmt(weeklySigmaPct(iv), 1)}%; size strikes against that, not against the verdict word.`);
  }

  return [
    {
      side: "puts",
      stance: v === "supportive" ? "supported" : v === "caution" ? "cautious" : "neutral",
      headline:
        v === "supportive"
          ? "Street supports underlyer quality — still verify put credit vs buffer"
          : v === "caution"
            ? "Street weakens put thesis — require better premium or wider strikes"
            : "IBES neutral for puts",
      bullets: putBullets,
    },
    {
      side: "calls",
      stance: v === "caution" ? "supported" : v === "supportive" ? "cautious" : "neutral",
      headline:
        v === "supportive"
          ? "Street upside risk — don’t treat as free call-sell"
          : v === "caution"
            ? "Street softness can help covered calls — still price the chain"
            : "IBES neutral for calls",
      bullets: callBullets,
    },
  ];
}

export function wrdsConclusion(data: WrdsPayload): string {
  if (!data.available) return data.reason ?? "No WRDS IBES cache for this ticker.";
  const c = data.consensus;
  if (!c) return data.headline;
  const bits: string[] = [];
  if (c.meanDriftPct != null) {
    bits.push(`FY1 ${fmtPct(c.meanDriftPct)} drift`);
  }
  const br = data.peers?.metrics?.breadth;
  if (c.breadth != null) {
    const rel = br?.peerPct != null ? ` (p${Math.round(br.peerPct)})` : "";
    bits.push(`breadth ${fmt(c.breadth)}${rel}`);
  }
  const sueM = data.peers?.metrics?.sue;
  if (c.sue != null) {
    const rel = sueM?.peerPct != null ? ` (p${Math.round(sueM.peerPct)})` : "";
    bits.push(`SUE ${fmt(c.sue)}${rel}`);
  }
  const core = bits.length ? bits.join(" · ") : data.headline;
  const v =
    data.verdict === "supportive"
      ? "Supportive"
      : data.verdict === "caution"
        ? "Caution"
        : "Neutral";
  const grp = peerGroupLabel(data.peers);
  return `${v}: ${core}${grp ? ` · vs ${grp}` : ""}.`;
}

export function wrdsCompactChips(data: WrdsPayload): RelChip[] {
  const c = data.consensus;
  const chips: RelChip[] = [];
  const br = data.peers?.metrics?.breadth;
  const sueM = data.peers?.metrics?.sue;

  if (c?.meanDriftPct != null) {
    chips.push({
      label: "FY1 drift",
      value: fmtPct(c.meanDriftPct),
      hint: c.meanest != null ? `level $${fmt(c.meanest)} (not peer-cmp)` : "vs prior statsum",
      tone: c.meanDriftPct >= 1 ? "good" : c.meanDriftPct <= -1 ? "bad" : "neutral",
    });
  }
  if (c?.breadth != null) {
    chips.push({
      label: "Breadth",
      value: fmt(c.breadth),
      hint: fmtRelHint(br) ?? "≥0.08 supportive abs",
      tone: br?.peerPct != null ? relTone(br.peerPct) : c.breadth >= 0.08 ? "good" : c.breadth <= -0.08 ? "bad" : "neutral",
    });
  }
  if (c?.sue != null) {
    chips.push({
      label: "SUE",
      value: fmt(c.sue),
      hint: fmtRelHint(sueM) ?? "≥0.5 beat streak abs",
      tone: sueM?.peerPct != null ? relTone(sueM.peerPct) : c.sue >= 0.5 ? "good" : c.sue <= -0.5 ? "bad" : "neutral",
    });
  }
  const iv = data.tech?.iv;
  if (iv != null) {
    chips.push({
      label: "IV",
      value: `${iv.toFixed(0)}%`,
      hint: `~${fmt(iv * Math.sqrt(7 / 365), 1)}% 1w 1σ`,
      tone: "neutral",
    });
  }
  if (data.peers?.leaders?.[0]) {
    const top = data.peers.leaders[0];
    chips.push({
      label: "Peer #1 br",
      value: top.ticker,
      hint: fmt(top.value),
      tone: "neutral",
    });
  }
  return chips.slice(0, 6);
}

export function wrdsHowTo(data: WrdsPayload): string {
  return peerHowToUse(data.peers, "wrds");
}

export function revisionChartData(data: WrdsPayload) {
  return (data.revisionSeries ?? [])
    .filter((r) => r.statpers)
    .map((r) => ({
      date: r.statpers!.slice(5), // MM-DD
      full: r.statpers,
      mean: r.meanest,
      breadth: r.breadth != null ? r.breadth * 100 : null,
      n: r.numest,
    }));
}

export function sueChartData(data: WrdsPayload) {
  return [...(data.surprises ?? [])]
    .filter((s) => s.anndats && s.sue != null)
    .reverse()
    .map((s) => ({
      date: s.anndats!.slice(5),
      full: s.anndats,
      sue: s.sue,
      actual: s.actual,
      est: s.surpmean,
    }));
}
