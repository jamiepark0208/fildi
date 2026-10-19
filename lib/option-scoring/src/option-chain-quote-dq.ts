/**
 * Option chain bid data-quality: "no live bid" is a vendor/quote problem, not a trading preference.
 * Sell-side income uses bid only — if the chain has ask/last but bid=0, DQ is degraded.
 */

export interface ChainOptionLike {
  bid: number;
  ask: number;
  bidIsLive?: boolean;
  meetsGate?: boolean;
}

export interface ChainLike {
  source?: "schwab" | "yahoo";
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
  /** Short UI line */
  message: string;
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
      message: "DQ: empty chain",
    };
  }

  const source = chains.find((c) => c.source)?.source ?? "unknown";
  let inBand = 0;
  let withLiveBid = 0;
  let withAskNoBid = 0;
  let meetsGate = 0;

  for (const c of chains) {
    for (const p of isCall ? c.calls : c.puts) {
      inBand++;
      const live = (p.bidIsLive ?? p.bid > 0) && p.bid > 0;
      if (live) withLiveBid++;
      else if (p.ask > 0) withAskNoBid++;
      if (p.meetsGate) meetsGate++;
    }
  }

  const liveBidPct = inBand > 0 ? Math.round((100 * withLiveBid) / inBand) : 0;
  const degraded = inBand > 0 && withLiveBid === 0;

  let code: QuoteDqCode = "ok";
  let message = `DQ ok · ${source} · ${withLiveBid}/${inBand} live bids (${liveBidPct}%)`;

  if (inBand === 0) {
    code = "empty";
    message = `DQ: ${source} chain has no contracts in 3–25% OTM band`;
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
  } else if (source === "yahoo") {
    code = "yahoo_fallback";
    message = `DQ warn · Yahoo fallback · ${withLiveBid}/${inBand} live bids — prefer Schwab`;
    // Yahoo with some bids is degraded for confidence, not a hard fail
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
    message,
  };
}
