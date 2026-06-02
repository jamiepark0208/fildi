import YahooFinanceClass from "yahoo-finance2";
import { getTier, TIER_CONFIG } from "./constants.js";

const yahooFinance = new YahooFinanceClass();

// ── Types ────────────────────────────────────────────────────────────────────

export interface OptionRow {
  strike: number;
  bid: number;
  ask: number;
  lastPrice: number;
  iv: number;
  volume: number | null;
  incomePct: number;
  meetsGate: boolean;
}

export interface OptionsChainResult {
  ticker: string;
  expiry: string;
  isWeekly: boolean;
  daysToExpiry: number;
  spot: number;
  tier: 1 | 2 | 3;
  puts: OptionRow[];
  fetchedAt: number;
}

// Raw shape we read from yf2 (validateResult: false)
interface RawContract {
  strike?: number;
  bid?: number;
  ask?: number;
  lastPrice?: number;
  impliedVolatility?: number;
  volume?: number;
}

interface RawOptionsResponse {
  expirationDates?: unknown[];
  quote?: { regularMarketPrice?: number };
  options?: Array<{
    expirationDate?: unknown;
    puts?: RawContract[];
  }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDateStr(d: unknown): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === "string") return d.slice(0, 10);
  return "";
}

function daysUntil(d: unknown): number {
  const ms = (d instanceof Date ? d.getTime() : 0) - Date.now();
  return Math.ceil(ms / 86_400_000);
}

function isWeeklyExpiry(d: unknown): boolean {
  return d instanceof Date && d.getDay() === 5; // Friday
}

function buildRows(
  puts: RawContract[],
  spot: number,
  minOTM: number,
  maxOTM: number,
  minIncome: number,
): OptionRow[] {
  const lo = spot * (1 - maxOTM);
  const hi = spot * (1 - minOTM);

  return puts
    .filter(p => typeof p.strike === "number" && p.strike >= lo && p.strike <= hi)
    .map(p => {
      const strike    = p.strike!;
      const bid       = p.bid       ?? 0;
      const ask       = p.ask       ?? 0;
      const lastPrice = p.lastPrice ?? 0;
      const iv        = p.impliedVolatility ?? 0;
      const volume    = typeof p.volume === "number" ? p.volume : null;
      const incomePct = bid > 0 ? (bid / strike) * 100 : 0;
      return {
        strike, bid, ask, lastPrice, iv, volume,
        incomePct: Math.round(incomePct * 1000) / 1000,
        meetsGate: incomePct >= minIncome * 100,
      };
    })
    .sort((a, b) => b.strike - a.strike);
}

async function fetchChain(ticker: string, date?: Date): Promise<RawOptionsResponse> {
  const opts = date ? { date } : {};
  return yahooFinance.options(
    ticker,
    opts as Parameters<typeof yahooFinance.options>[1],
    { validateResult: false },
  ) as Promise<RawOptionsResponse>;
}

// ── Public API — no server-side caching, fresh on every click ─────────────────

export async function getOptionsChain(ticker: string): Promise<OptionsChainResult> {
  const key = ticker.toUpperCase();

  let raw = await fetchChain(key);

  const spot = raw.quote?.regularMarketPrice;
  if (!spot) throw new Error(`No spot price for ${key}`);

  const dates      = raw.expirationDates ?? [];
  let expiryDate   = raw.options?.[0]?.expirationDate;
  let puts         = raw.options?.[0]?.puts ?? [];

  // Step to the next expiry if current one expires today or tomorrow
  if (daysUntil(expiryDate) <= 1 && dates.length > 1) {
    const next = dates[1];
    raw        = await fetchChain(key, next instanceof Date ? next : undefined);
    expiryDate = raw.options?.[0]?.expirationDate ?? next;
    puts       = raw.options?.[0]?.puts ?? [];
  }

  const tier   = getTier(key);
  const config = TIER_CONFIG[tier];
  const dte    = daysUntil(expiryDate);

  // Normalise income gate to weekly equivalent when using a 2-week expiry
  const weeksOut  = Math.max(1, Math.round(dte / 7));
  const weeklyMin = config.minIncome / weeksOut;

  return {
    ticker: key,
    expiry: toDateStr(expiryDate),
    isWeekly: isWeeklyExpiry(expiryDate),
    daysToExpiry: dte,
    spot,
    tier,
    puts: buildRows(puts, spot, config.minOTM, config.maxOTM, weeklyMin),
    fetchedAt: Date.now(),
  };
}
