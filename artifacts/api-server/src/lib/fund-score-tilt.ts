/** A83 — intra-family tilts + metric exclusions (split from fund-score-engine). */
import type { FundRowInput, MetricDef, MetricKey, StyleBucket } from "./fund-score-types.js";
import {
  isChineseLike,
  isCyclicalLike,
  isDistressed,
  isEconomicallyPreRevenue,
  isFinancialLike,
  isReitLike,
  isUnprofitableOperator,
} from "./fund-score-style.js";

export function approxWacc(beta: number | null): number | null {
  if (beta == null || !Number.isFinite(beta)) return null;
  return 0.045 + beta * 0.055;
}

export function intraTilt(key: MetricKey, style: StyleBucket, base: number, r: FundRowInput): number {
  let w = base;
  if (key === "peg") {
    if (style === "growth" || style === "garp") w *= 1.4;
    if (style === "value") w *= 0.5;
  }
  // Value ↔ growth symmetry: value names overweight cheapness metrics; growth overweights growth prints
  if (key === "earningsYield" || key === "fcfYield" || key === "evEbitda" || key === "expEy" || key === "pb" || key === "ps") {
    if (style === "value") w *= 1.35;
    if (style === "growth") w *= 0.7;
    if (style === "quality_defensive" && (key === "fcfYield" || key === "expEy")) w *= 1.15;
  }
  if (key === "revgrow" || key === "epsgrow") {
    if (style === "growth" || style === "pre_revenue") w *= 1.15;
    if (style === "value") w *= 0.7;
    if (style === "quality_defensive") w *= 0.85;
  }
  if (key === "roicwacc" || key === "grossmgn" || key === "gpa" || key === "operatingmgn" || key === "netmgn" || key === "fcfmgn") {
    if (style === "quality_defensive") w *= 1.35;
    if (style === "garp" || style === "growth") w *= 1.2;
    if (style === "value") w *= 1.1; // value still cares about quality, mildly
  }
  if (key === "netDebtEbitda" || key === "intcov" || key === "fScore" || key === "cr" || key === "de" || key === "beta" || key === "netCashAssets") {
    if (style === "value" || style === "quality_defensive") w *= 1.25;
  }
  if (key === "cashrun" && style === "financial") w *= 0.25;

  // Dilution matters most for growth / pre-revenue (SBC-funded)
  if (key === "dilution" && (style === "growth" || style === "pre_revenue")) w *= 1.5;

  // Financials: book + ROE + P/TBV carry the quality/value signal; leverage ratios are structural
  if (style === "financial" || isFinancialLike(r)) {
    if (key === "roe" || key === "pb" || key === "divy" || key === "ptbv") w *= 1.35;
    if (key === "ptbv") w *= 1.25; // stack on top of financial tilt
    if (key === "pb" && r.tangibleBookValuePerShare != null) w *= 0.55; // prefer P/TBV when available
    if (key === "cr") w *= 0.5;
  }

  // REITs: distribution + FFO/FCF proxy over NI margins
  if (isReitLike(r)) {
    if (key === "divy" || key === "fcfYield" || key === "fcfmgn" || key === "pFfo") w *= 1.4;
    if (key === "netmgn" || key === "earningsYield") w *= 0.5;
  }

  // Cyclicals (incl. semis/memory): peak EY/margins look "quality" — prefer EV/EBITDA + FCF + expected EY
  if (isCyclicalLike(r)) {
    if (key === "earningsYield") w *= 0.55;
    if (key === "roe" || key === "netmgn" || key === "grossmgn") w *= 0.65;
    if (key === "evEbitda" || key === "fcfYield" || key === "expEy") w *= 1.35;
  }

  // Chinese / VIE: don't over-trust accounting ROE; lean safety + expected EY over PEG
  if (isChineseLike(r)) {
    if (key === "roe" || key === "roicwacc") w *= 0.75;
    if (key === "peg") w *= 0.5;
    if (key === "cashrun" || key === "fcfYield" || key === "dilution" || key === "beta" || key === "netCashAssets") w *= 1.25;
    if (key === "expEy") w *= 1.2;
  }

  // Distressed: value traps — haircut cheapness, amplify liquidity/dilution
  if (isDistressed(r)) {
    if (key === "earningsYield" || key === "pb" || key === "ps") w *= 0.4;
    if (key === "cashrun" || key === "cr" || key === "dilution") w *= 1.5;
  }

  if (key === "upside") w = Math.min(w, 1);
  return w;
}

export function isExcluded(m: MetricDef, style: StyleBucket, scoringMode: string | null, r?: FundRowInput): boolean {
  if (m.excludeStyles?.includes(style)) return true;
  if (!r) return false;

  if (
    scoringMode === "pre_revenue_ok" &&
    isEconomicallyPreRevenue(r) &&
    (m.key === "peg" || m.key === "earningsYield" || m.key === "fwdpe")
  ) {
    return true;
  }
  if (isUnprofitableOperator(r) && (m.key === "peg" || m.key === "earningsYield" || m.key === "epsgrow")) {
    return true;
  }

  // Banks / insurers / REITs: structural leverage — D/E and ND/EBITDA are not comparable to corporates
  if (isFinancialLike(r) && (m.key === "de" || m.key === "netDebtEbitda")) return true;
  // Banks: current ratio is not a meaningful liquidity signal
  if ((scoringMode === "financial" || (r.peerGroupId && /bank/i.test(r.peerGroupId))) && m.key === "cr") {
    return true;
  }
  // REITs: NI margin / ROIC-WACC poorly mapped to FFO economics
  if (isReitLike(r) && (m.key === "roicwacc" || m.key === "netmgn")) return true;
  // Distressed: PB as "value" is noise when equity is negative
  if (isDistressed(r) && m.key === "pb" && r.priceToBook != null && r.priceToBook < 0) return true;
  // P/TBV only meaningful for banks/insurers/brokers (goodwill-heavy financials)
  if (m.key === "ptbv" && !isFinancialLike(r)) return true;
  // P/FFO only for REITs (FFO proxy = NI + D&A)
  if (m.key === "pFfo" && !isReitLike(r)) return true;

  return false;
}
