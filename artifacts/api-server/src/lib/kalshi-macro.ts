/**
 * A82 — Kalshi public read for macro odds (FOMC decision + CPI YoY median).
 * Internal display only (Kalshi ToS / CFTC 11.1). Hourly TTL; no redistribution.
 */
import { fetchJsonWithRetry } from "./http-client.js";
import { TTLCache } from "./ttl-cache.js";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const UA = "TradeDash/1.0 (internal macro odds; personal use)";

export const kalshiMacroCache = new TTLCache<KalshiMacroStrip>(60 * 60_000, "kalshi-macro", 4);

export interface FomcOdds {
  eventTicker: string;
  /** e.g. "10-28" */
  dateLabel: string;
  holdPct: number;
  cutPct: number;
  hikePct: number;
  /** Sum of open interest across decision markets (contracts). */
  oi: number;
}

export interface CpiOdds {
  eventTicker: string;
  /** e.g. "Nov" */
  monthLabel: string;
  /** Market-implied median YoY % from the Above-X ladder (P≈0.5). */
  medianYoY: number;
  oi: number;
}

export interface KalshiMacroStrip {
  asOf: string;
  source: "kalshi";
  internalOnly: true;
  fomc: FomcOdds | null;
  cpi: CpiOdds | null;
  error?: string;
}

interface KalshiEvent {
  event_ticker?: string;
  title?: string;
  strike_date?: string;
  sub_title?: string;
}

interface KalshiMarket {
  yes_sub_title?: string;
  subtitle?: string;
  last_price_dollars?: string | number;
  yes_bid_dollars?: string | number;
  open_interest_fp?: string | number;
  open_interest?: number;
}

function pct(dollars: string | number | undefined | null): number {
  const n = typeof dollars === "number" ? dollars : parseFloat(String(dollars ?? ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function oiOf(m: KalshiMarket): number {
  const raw = m.open_interest_fp ?? m.open_interest;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function yesProb(m: KalshiMarket): number {
  const last = typeof m.last_price_dollars === "number"
    ? m.last_price_dollars
    : parseFloat(String(m.last_price_dollars ?? ""));
  if (Number.isFinite(last) && last > 0) return last;
  const bid = typeof m.yes_bid_dollars === "number"
    ? m.yes_bid_dollars
    : parseFloat(String(m.yes_bid_dollars ?? ""));
  return Number.isFinite(bid) ? bid : 0;
}

async function kalshiGet<T>(path: string): Promise<T> {
  return fetchJsonWithRetry<T>(`${BASE}${path}`, {
    provider: "Kalshi",
    timeoutMs: 12_000,
    maxRetries: 2,
    init: { headers: { Accept: "application/json", "User-Agent": UA } },
  });
}

function dateLabelFromStrike(iso: string | undefined): string {
  if (!iso || iso.length < 10) return "?";
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return `${m}-${String(d).padStart(2, "0")}`;
}

function monthLabelFromTicker(eventTicker: string, strike: string | undefined): string {
  // KXCPIYOY-26NOV → Nov
  const m = eventTicker.match(/-(\d{2})([A-Z]{3})$/i);
  if (m) {
    const mon = m[2]!.slice(0, 1) + m[2]!.slice(1).toLowerCase();
    return mon;
  }
  if (strike && strike.length >= 7) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months[Number(strike.slice(5, 7)) - 1] ?? "?";
  }
  return "?";
}

async function fetchFomc(): Promise<FomcOdds | null> {
  const events = await kalshiGet<{ events?: KalshiEvent[] }>(
    "/events?limit=1&status=open&series_ticker=KXFEDDECISION",
  );
  const ev = events.events?.[0];
  if (!ev?.event_ticker) return null;
  const markets = await kalshiGet<{ markets?: KalshiMarket[] }>(
    `/markets?limit=20&status=open&event_ticker=${encodeURIComponent(ev.event_ticker)}`,
  );
  let hold = 0, cut = 0, hike = 0, oi = 0;
  for (const m of markets.markets ?? []) {
    const sub = (m.yes_sub_title || m.subtitle || "").toLowerCase();
    const p = pct(yesProb(m));
    oi += oiOf(m);
    if (sub.includes("maintain")) hold += p;
    else if (sub.includes("cut")) cut += p;
    else if (sub.includes("hike")) hike += p;
  }
  if (hold + cut + hike === 0) return null;
  return {
    eventTicker: ev.event_ticker,
    dateLabel: dateLabelFromStrike(ev.strike_date),
    holdPct: hold,
    cutPct: cut,
    hikePct: hike,
    oi: Math.round(oi),
  };
}

/** Median YoY from Above-X% ladder: first rung where P(yes) ≤ 50%. */
async function fetchCpi(): Promise<CpiOdds | null> {
  const events = await kalshiGet<{ events?: KalshiEvent[] }>(
    "/events?limit=1&status=open&series_ticker=KXCPIYOY",
  );
  const ev = events.events?.[0];
  if (!ev?.event_ticker) return null;
  const markets = await kalshiGet<{ markets?: KalshiMarket[] }>(
    `/markets?limit=40&status=open&event_ticker=${encodeURIComponent(ev.event_ticker)}`,
  );
  const rungs: { x: number; p: number; oi: number }[] = [];
  let oi = 0;
  for (const m of markets.markets ?? []) {
    const sub = m.yes_sub_title || m.subtitle || "";
    const mm = sub.match(/([\d.]+)/);
    if (!mm) continue;
    const x = parseFloat(mm[1]!);
    if (!Number.isFinite(x)) continue;
    const p = yesProb(m);
    oi += oiOf(m);
    rungs.push({ x, p, oi: oiOf(m) });
  }
  if (rungs.length === 0) return null;
  rungs.sort((a, b) => a.x - b.x);
  let median = rungs[rungs.length - 1]!.x;
  for (const r of rungs) {
    if (r.p <= 0.5) { median = r.x; break; }
  }
  return {
    eventTicker: ev.event_ticker,
    monthLabel: monthLabelFromTicker(ev.event_ticker, ev.strike_date),
    medianYoY: Math.round(median * 10) / 10,
    oi: Math.round(oi),
  };
}

export async function fetchKalshiMacroStrip(): Promise<KalshiMacroStrip> {
  return kalshiMacroCache.getOrCompute("strip", async () => {
    try {
      const [fomc, cpi] = await Promise.all([
        fetchFomc().catch(() => null),
        fetchCpi().catch(() => null),
      ]);
      return {
        asOf: new Date().toISOString(),
        source: "kalshi",
        internalOnly: true,
        fomc,
        cpi,
        ...(fomc || cpi ? {} : { error: "no open Kalshi macro markets" }),
      };
    } catch (e) {
      return {
        asOf: new Date().toISOString(),
        source: "kalshi",
        internalOnly: true,
        fomc: null,
        cpi: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
}
