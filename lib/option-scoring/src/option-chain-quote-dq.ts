/**
 * Option chain bid data-quality: "no live bid" is a vendor/quote problem, not a trading preference.
 * Sell-side income uses bid only — if the chain has ask/last but bid=0, DQ is degraded.
 */

export interface ChainOptionLike {
  bid: number;
  ask: number;
  bidIsLive?: boolean;
  meetsGate?: boolean;
  /** Present on live chains — used to name ask-only (bid=0) strikes in DQ copy. */
  strike?: number;
}

export interface ChainLike {
  source?: "schwab" | "yahoo";
  /** Expiry label (YYYY-MM-DD) — pairs with option.strike for ask-only samples. */
  expiry?: string;
  spot?: number;
  puts: ChainOptionLike[];
  calls: ChainOptionLike[];
}

export type QuoteDqCode =
  | "ok"
  | "empty"
  | "yahoo_fallback"
  | "zero_bids_yahoo"
  | "zero_bids_schwab"
  | "zero_bids";

export interface OptionChainQuoteDq {
  source: "schwab" | "yahoo" | "unknown";
  inBand: number;
  withLiveBid: number;
  withAskNoBid: number;
  meetsGate: number;
  liveBidPct: number;
  degraded: boolean;
  code: QuoteDqCode;
  /** Ask-only (bid=0, ask>0) contract labels, e.g. "2026-10-21 $305P". */
  askOnlySamples: string[];
  /** Short UI line */
  message: string;
}

function formatStrikeSample(expiry: string | undefined, strike: number | undefined, isCall: boolean): string | null {
  if (strike == null || !Number.isFinite(strike)) return null;
  const side = isCall ? "C" : "P";
  const k = Number.isInteger(strike) ? String(strike) : strike.toFixed(2).replace(/\.?0+$/, "");
  return expiry ? `${expiry} $${k}${side}` : `$${k}${side}`;
}

function appendAskOnly(message: string, samples: string[], withAskNoBid: number): string {
  if (withAskNoBid <= 0) return message;
  if (samples.length === 0) {
    return `${message} · ${withAskNoBid} ask-only (bid=0)`;
  }
  const shown = samples.slice(0, 4).join(", ");
  const more = withAskNoBid > samples.length ? ` (+${withAskNoBid - samples.length} more)` : "";
  return `${message} · bid=0 e.g. ${shown}${more}`;
}

export function assessOptionChainQuoteDq(
  chains: ChainLike[] | null | undefined,
  isCall: boolean,
): OptionChainQuoteDq {
  if (!chains?.length) {
    return {
      source: "unknown",
      inBand: 0,
      withLiveBid: 0,
      withAskNoBid: 0,
      meetsGate: 0,
      liveBidPct: 0,
      degraded: true,
      code: "empty",
      askOnlySamples: [],
      message: "DQ: empty chain",
    };
  }

  const source = chains.find((c) => c.source)?.source ?? "unknown";
  const spot = chains.find((c) => c.spot != null && c.spot > 0)?.spot;
  let inBand = 0;
  let withLiveBid = 0;
  let withAskNoBid = 0;
  let meetsGate = 0;
  const askOnlySamples: string[] = [];

  for (const c of chains) {
    for (const p of isCall ? c.calls : c.puts) {
      inBand++;
      const live = (p.bidIsLive ?? p.bid > 0) && p.bid > 0;
      if (live) withLiveBid++;
      else if (p.ask > 0) {
        withAskNoBid++;
        if (askOnlySamples.length < 6) {
          const label = formatStrikeSample(c.expiry, p.strike, isCall);
          if (label) askOnlySamples.push(label);
        }
      }
      if (p.meetsGate) meetsGate++;
    }
  }

  const liveBidPct = inBand > 0 ? Math.round((100 * withLiveBid) / inBand) : 0;
  const degraded = inBand > 0 && withLiveBid === 0;

  let code: QuoteDqCode = "ok";
  let message = `DQ ok · ${source} · ${withLiveBid}/${inBand} live bids (${liveBidPct}%)`;

  if (inBand === 0) {
    code = "empty";
    // Keep hint aligned with chain builders (sub-$10 uses 40% max OTM for coarse strikes).
    const maxOtm = spot != null && spot > 0 && spot < 10 ? 0.40 : 0.25;
    const bandHint = spot != null && spot > 0
      ? (isCall
        ? ` (spot $${spot.toFixed(2)} → call strikes ~$${(spot * 1.03).toFixed(2)}–$${(spot * (1 + maxOtm)).toFixed(2)})`
        : ` (spot $${spot.toFixed(2)} → put strikes ~$${(spot * (1 - maxOtm)).toFixed(2)}–$${(spot * 0.97).toFixed(2)})`)
      : "";
    message = `DQ: ${source} chain has no contracts in OTM band${bandHint}`;
  } else if (degraded) {
    if (source === "schwab") {
      code = "zero_bids_schwab";
      message = `DQ FAIL · Schwab · 0/${inBand} live bids` +
        (withAskNoBid > 0 ? ` (${withAskNoBid} ask-only — bid missing from vendor)` : "");
    } else if (source === "yahoo") {
      code = "zero_bids_yahoo";
      message = `DQ FAIL · Yahoo fallback · 0/${inBand} live bids` +
        (withAskNoBid > 0 ? ` (${withAskNoBid} ask-only)` : "") +
        " — Schwab miss or after-hours Yahoo zeros";
    } else {
      code = "zero_bids";
      message = `DQ FAIL · unknown source · 0/${inBand} live bids`;
    }
    message = appendAskOnly(message, askOnlySamples, withAskNoBid);
  } else if (source === "yahoo") {
    code = "yahoo_fallback";
    message = `DQ warn · Yahoo fallback · ${withLiveBid}/${inBand} live bids — prefer Schwab`;
    message = appendAskOnly(message, askOnlySamples, withAskNoBid);
  } else if (withAskNoBid > 0) {
    message = appendAskOnly(message, askOnlySamples, withAskNoBid);
  }

  return {
    source,
    inBand,
    withLiveBid,
    withAskNoBid,
    meetsGate,
    liveBidPct,
    degraded: degraded || source === "yahoo",
    code,
    askOnlySamples,
    message,
  };
}
