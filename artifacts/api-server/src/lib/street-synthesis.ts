/**
 * Unified Street view for Breakdown: Yahoo level + WRDS path + LSEG quality/conflicts.
 * Soft evidence only — does not mutate fund_score.
 */

export type StreetTone = "supportive" | "neutral" | "caution";

export type StreetSynthesisInput = {
  ticker: string;
  yahoo?: {
    strongBuy?: number;
    buy?: number;
    hold?: number;
    sell?: number;
    strongSell?: number;
    targetMean?: number | null;
    price?: number | null;
  } | null;
  wrds?: {
    available?: boolean;
    breadth?: number | null;
    sue?: number | null;
    meanest?: number | null;
    meanDriftPct?: number | null;
    streetEventRisk?: boolean;
    verdict?: StreetTone | string | null;
  } | null;
  lseg?: {
    available?: boolean;
    recMean?: number | null; // 1=strong buy … 5=sell typical
    targetPrice?: number | null;
    epsDrift30dPct?: number | null;
    armRank?: number | null;
    predSurprisePct?: number | null;
    combinedAlphaRank?: number | null;
  } | null;
};

export type StreetConflict = {
  code: string;
  text: string;
};

export type StreetSynthesis = {
  ticker: string;
  tone: StreetTone;
  level: {
    yahooBullishPct: number | null;
    yahooTargetUpsidePct: number | null;
    lsegRecMean: number | null;
    lsegTargetUpsidePct: number | null;
    summary: string | null;
  };
  path: {
    ibesBreadth: number | null;
    ibesSue: number | null;
    meanDriftPct: number | null;
    epsDrift30dPct: number | null;
    predSurprisePct: number | null;
    summary: string | null;
  };
  quality: {
    armRank: number | null;
    combinedAlphaRank: number | null;
    summary: string | null;
  };
  eventRisk: boolean;
  conflicts: StreetConflict[];
  sources: string[];
};

function yahooBullishPct(y: StreetSynthesisInput["yahoo"]): number | null {
  if (!y) return null;
  const sb = y.strongBuy ?? 0;
  const b = y.buy ?? 0;
  const h = y.hold ?? 0;
  const s = y.sell ?? 0;
  const ss = y.strongSell ?? 0;
  const n = sb + b + h + s + ss;
  if (n <= 0) return null;
  return ((sb + b) / n) * 100;
}

function upside(target: number | null | undefined, price: number | null | undefined): number | null {
  if (target == null || price == null || price <= 0) return null;
  const pct = ((target / price) - 1) * 100;
  // A113: |upside| > 300% → treat as stale (don't surface as street upside).
  if (Math.abs(pct) > 300) return null;
  return pct;
}

function toneFromInputs(
  bullish: number | null,
  breadth: number | null,
  sue: number | null,
  epsDrift: number | null,
): StreetTone {
  let score = 0;
  let n = 0;
  if (bullish != null) {
    n++;
    score += bullish >= 60 ? 1 : bullish <= 35 ? -1 : 0;
  }
  if (breadth != null) {
    n++;
    score += breadth >= 0.1 ? 1 : breadth <= -0.1 ? -1 : 0;
  }
  if (sue != null) {
    n++;
    score += sue >= 0.5 ? 1 : sue <= -0.5 ? -1 : 0;
  }
  if (epsDrift != null) {
    n++;
    score += epsDrift >= 2 ? 1 : epsDrift <= -2 ? -1 : 0;
  }
  if (n === 0) return "neutral";
  if (score >= 1) return "supportive";
  if (score <= -1) return "caution";
  return "neutral";
}

export function synthesizeStreet(input: StreetSynthesisInput): StreetSynthesis {
  const ticker = input.ticker.toUpperCase();
  const sources: string[] = [];
  if (input.yahoo) sources.push("yahoo");
  if (input.wrds?.available) sources.push("wrds");
  if (input.lseg?.available) sources.push("lseg");

  const bullish = yahooBullishPct(input.yahoo);
  const yahooUpside = upside(input.yahoo?.targetMean, input.yahoo?.price);
  const lsegUpside = upside(input.lseg?.targetPrice, input.yahoo?.price);
  const breadth = input.wrds?.breadth ?? null;
  const sue = input.wrds?.sue ?? null;
  const meanDrift = input.wrds?.meanDriftPct ?? null;
  const epsDrift = input.lseg?.epsDrift30dPct ?? null;
  const predSurp = input.lseg?.predSurprisePct ?? null;

  const conflicts: StreetConflict[] = [];

  if (yahooUpside != null && lsegUpside != null && Math.abs(yahooUpside - lsegUpside) >= 8) {
    conflicts.push({
      code: "pt_gap",
      text: `${ticker}: Yahoo PT ${yahooUpside >= 0 ? "+" : ""}${yahooUpside.toFixed(0)}% vs LSEG PT ${lsegUpside >= 0 ? "+" : ""}${lsegUpside.toFixed(0)}%`,
    });
  }

  if (bullish != null && bullish >= 65 && breadth != null && breadth <= -0.1) {
    conflicts.push({
      code: "buy_vs_cuts",
      text: `${ticker}: Yahoo ${bullish.toFixed(0)}% buy/overweight while IBES breadth ${breadth.toFixed(2)} (net cuts)`,
    });
  }

  if (bullish != null && bullish <= 40 && breadth != null && breadth >= 0.15) {
    conflicts.push({
      code: "sell_vs_raises",
      text: `${ticker}: Yahoo only ${bullish.toFixed(0)}% bullish while IBES breadth +${breadth.toFixed(2)}`,
    });
  }

  if (epsDrift != null && meanDrift != null && Math.sign(epsDrift) !== Math.sign(meanDrift) && Math.abs(epsDrift) >= 2 && Math.abs(meanDrift) >= 2) {
    conflicts.push({
      code: "drift_disagree",
      text: `${ticker}: LSEG 30d EPS drift ${epsDrift >= 0 ? "+" : ""}${epsDrift.toFixed(1)}% vs WRDS mean drift ${meanDrift >= 0 ? "+" : ""}${meanDrift.toFixed(1)}%`,
    });
  }

  if (predSurp != null && sue != null && Math.sign(predSurp) !== Math.sign(sue) && Math.abs(predSurp) >= 2 && Math.abs(sue) >= 0.8) {
    conflicts.push({
      code: "surprise_disagree",
      text: `${ticker}: LSEG pred surprise ${predSurp >= 0 ? "+" : ""}${predSurp.toFixed(1)}% vs IBES SUE ${sue.toFixed(2)}`,
    });
  }

  const tone = toneFromInputs(bullish, breadth, sue, epsDrift);
  const eventRisk = !!(input.wrds?.streetEventRisk);

  const levelBits: string[] = [];
  if (bullish != null) levelBits.push(`Yahoo ${bullish.toFixed(0)}% bullish`);
  if (yahooUpside != null) levelBits.push(`PT ${yahooUpside >= 0 ? "+" : ""}${yahooUpside.toFixed(0)}%`);
  if (input.lseg?.recMean != null) levelBits.push(`LSEG rec ${input.lseg.recMean.toFixed(2)}`);
  if (lsegUpside != null && yahooUpside == null) levelBits.push(`LSEG PT ${lsegUpside >= 0 ? "+" : ""}${lsegUpside.toFixed(0)}%`);

  const pathBits: string[] = [];
  if (breadth != null) pathBits.push(`IBES breadth ${breadth >= 0 ? "+" : ""}${breadth.toFixed(2)}`);
  if (sue != null) pathBits.push(`SUE ${sue.toFixed(2)}`);
  if (meanDrift != null) pathBits.push(`mean ${meanDrift >= 0 ? "+" : ""}${meanDrift.toFixed(1)}%`);
  if (epsDrift != null) pathBits.push(`30d EPS ${epsDrift >= 0 ? "+" : ""}${epsDrift.toFixed(1)}%`);
  if (predSurp != null) pathBits.push(`pred surp ${predSurp >= 0 ? "+" : ""}${predSurp.toFixed(1)}%`);

  const qualityBits: string[] = [];
  if (input.lseg?.armRank != null) qualityBits.push(`ARM ${input.lseg.armRank}`);
  if (input.lseg?.combinedAlphaRank != null) qualityBits.push(`α ${input.lseg.combinedAlphaRank}`);

  return {
    ticker,
    tone,
    level: {
      yahooBullishPct: bullish,
      yahooTargetUpsidePct: yahooUpside,
      lsegRecMean: input.lseg?.recMean ?? null,
      lsegTargetUpsidePct: lsegUpside,
      summary: levelBits.length ? levelBits.join(" · ") : null,
    },
    path: {
      ibesBreadth: breadth,
      ibesSue: sue,
      meanDriftPct: meanDrift,
      epsDrift30dPct: epsDrift,
      predSurprisePct: predSurp,
      summary: pathBits.length ? pathBits.join(" · ") : null,
    },
    quality: {
      armRank: input.lseg?.armRank ?? null,
      combinedAlphaRank: input.lseg?.combinedAlphaRank ?? null,
      summary: qualityBits.length ? qualityBits.join(" · ") : null,
    },
    eventRisk,
    conflicts,
    sources,
  };
}
