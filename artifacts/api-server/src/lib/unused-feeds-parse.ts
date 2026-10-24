/**
 * A267 pure mappers. Success check (no network):
 * - Form 4 P/S → buy/sell; net buys 90d = P value − S value
 * - 8-K → corporate event category
 * - related-companies tickers
 * - Schwab movers up/down, percent, volume
 * - expiry window is the listed band, not today+1..today+45
 * - empty vendor results back off (they must not eat a daily cap)
 * - Schwab hours override the calendar when present
 */

export type BuySell = "buy" | "sell" | "other";

export interface InsiderRow {
  rowKey: string;
  ticker: string;
  filed: string;
  insider: string | null;
  role: string | null;
  code: BuySell;
  secCode: string | null;
  shares: number | null;
  price: number | null;
  value: number | null;
  securityType: string | null;
}

export interface EventRow {
  rowKey: string;
  ticker: string;
  filed: string;
  category: string | null;
  primaryCategory: string | null;
  accession: string | null;
}

export interface MoverRow {
  symbol: string;
  percent: number | null;
  volume: number | null;
  lastPrice: number | null;
}

export interface ListedExpiry {
  expiry: string;
  expirationType: string | null;
  standard: boolean | null;
}

export interface SchwabMarketDay {
  date: string;
  isOpen: boolean;
  openMin: number;
  closeMin: number;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function ymdAdd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function ymdDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** True when this ticker should be fetched. Empty results back off longer than a hit. */
export function feedDue(
  asOf: string | null,
  rows: number,
  today: string,
  freshDays: number,
  emptyDays = 7,
): boolean {
  if (!asOf || !YMD.test(asOf)) return true;
  const age = ymdDiff(asOf, today);
  if (rows <= 0) return age >= emptyDays;
  return age >= freshDays;
}

/**
 * Listed expiries inside (today, today+horizon]. Null when the list has none —
 * caller may fall back. Never invents today+1 .. today+horizon.
 */
export function expiryWindowFromChain(
  expiries: string[],
  today: string,
  horizonDays = 45,
): { from: string; to: string } | null {
  const end = ymdAdd(today, horizonDays);
  const inBand = [...new Set(expiries.map((d) => d.slice(0, 10)))]
    .filter((d) => YMD.test(d) && d > today && d <= end)
    .sort();
  if (inBand.length === 0) return null;
  return { from: inBand[0]!, to: inBand[inBand.length - 1]! };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

export function rowKey(parts: Array<string | number | null | undefined>): string {
  return parts.map((p) => (p == null ? "" : String(p))).join("|");
}

export function tickersOfFiling(row: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const one = str(row.ticker);
  if (one) out.add(one.toUpperCase());
  const sym = str(row.issuer_trading_symbol);
  if (sym) out.add(sym.toUpperCase());
  if (Array.isArray(row.tickers)) {
    for (const t of row.tickers) {
      const s = str(t);
      if (s) out.add(s.toUpperCase());
    }
  }
  return [...out];
}

/** True when a ticker filter was ignored (most rows are for other names). */
export function filterLeak(results: Record<string, unknown>[], want: Set<string>): boolean {
  if (results.length === 0 || want.size === 0) return false;
  let hit = 0;
  for (const row of results) {
    if (tickersOfFiling(row).some((t) => want.has(t))) hit++;
  }
  return hit < 0.8 * results.length;
}

function buySell(secCode: string | null): BuySell {
  const c = (secCode ?? "").toUpperCase();
  if (c === "P") return "buy";
  if (c === "S") return "sell";
  return "other";
}

function roleOf(row: Record<string, unknown>): string | null {
  const title = str(row.officer_title);
  if (title) return title;
  if (row.is_director === true) return "director";
  if (row.is_ten_percent_owner === true) return "10%";
  if (row.is_officer === true) return "officer";
  if (row.is_other === true) return "other";
  return null;
}

export function mapForm4(results: unknown[], want: Set<string>): { rows: InsiderRow[]; leak: boolean } {
  const raw = results.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  if (filterLeak(raw, want)) return { rows: [], leak: true };
  const rows: InsiderRow[] = [];
  for (const row of raw) {
    const filed = str(row.filing_date)?.slice(0, 10) ?? null;
    if (!filed || !YMD.test(filed)) continue;
    const recordType = str(row.record_type);
    if (recordType && recordType.toLowerCase() === "holding") continue;
    const secCode = str(row.transaction_code);
    const names = tickersOfFiling(row).filter((t) => want.has(t));
    for (const ticker of names) {
      const shares = num(row.transaction_shares);
      rows.push({
        rowKey: rowKey([
          ticker,
          str(row.accession_number),
          str(row.owner_cik),
          str(row.transaction_date),
          secCode,
          str(row.security_title),
          shares,
        ]),
        ticker,
        filed,
        insider: str(row.owner_name),
        role: roleOf(row),
        code: buySell(secCode),
        secCode,
        shares,
        price: num(row.transaction_price_per_share),
        value: num(row.transaction_value),
        securityType: str(row.security_type),
      });
    }
  }
  return { rows, leak: false };
}

export function map8k(results: unknown[], want: Set<string>): { rows: EventRow[]; leak: boolean } {
  const raw = results.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  if (filterLeak(raw, want)) return { rows: [], leak: true };
  const rows: EventRow[] = [];
  for (const row of raw) {
    const filed = str(row.filing_date)?.slice(0, 10) ?? null;
    if (!filed || !YMD.test(filed)) continue;
    const category = str(row.tertiary_category) ?? str(row.secondary_category) ?? str(row.primary_category);
    const primary = str(row.primary_category);
    const accession = str(row.accession_number);
    for (const ticker of tickersOfFiling(row).filter((t) => want.has(t))) {
      rows.push({
        rowKey: rowKey([ticker, accession, primary, str(row.secondary_category), category]),
        ticker,
        filed,
        category,
        primaryCategory: primary,
        accession,
      });
    }
  }
  return { rows, leak: false };
}

export function mapRelated(body: unknown): string[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: string[] = [];
  for (const row of results) {
    const t = str((row as { ticker?: unknown })?.ticker)?.toUpperCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function mapMovers(body: unknown): MoverRow[] {
  const screeners = (body as { screeners?: unknown } | null)?.screeners;
  if (!Array.isArray(screeners)) return [];
  const out: MoverRow[] = [];
  for (const row of screeners) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const symbol = str(r.symbol)?.toUpperCase();
    if (!symbol) continue;
    out.push({
      symbol,
      percent: num(r.netPercentChange ?? r.netPercentChangeInDouble),
      volume: num(r.totalVolume ?? r.volume),
      lastPrice: num(r.lastPrice),
    });
  }
  return out;
}

export function parseExpirationChain(body: unknown): ListedExpiry[] {
  const list = (body as { expirationList?: unknown } | null)?.expirationList;
  if (!Array.isArray(list)) return [];
  const out: ListedExpiry[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const raw = str(r.expirationDate) ?? str(r.expiration);
    const expiry = raw?.slice(0, 10) ?? "";
    if (!YMD.test(expiry)) continue;
    out.push({
      expiry,
      expirationType: str(r.expirationType),
      standard: typeof r.standard === "boolean" ? r.standard : null,
    });
  }
  return out;
}

function clockMin(iso: string): number | null {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function findSession(node: unknown, depth: number): { date: string | null; isOpen: boolean; openMin: number | null; closeMin: number | null } | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const r = node as Record<string, unknown>;
  if (typeof r.isOpen === "boolean") {
    const hours = r.sessionHours as { regularMarket?: Array<{ start?: string; end?: string }> } | undefined;
    const reg = hours?.regularMarket?.[0];
    return {
      date: str(r.date)?.slice(0, 10) ?? null,
      isOpen: r.isOpen,
      openMin: reg?.start ? clockMin(reg.start) : null,
      closeMin: reg?.end ? clockMin(reg.end) : null,
    };
  }
  for (const v of Object.values(r)) {
    const hit = findSession(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function parseSchwabHours(body: unknown, today: string): SchwabMarketDay | null {
  const hit = findSession(body, 0);
  if (!hit) return null;
  const date = hit.date && YMD.test(hit.date) ? hit.date : today;
  return {
    date,
    isOpen: hit.isOpen,
    openMin: hit.openMin ?? 9 * 60 + 30,
    closeMin: hit.closeMin ?? 16 * 60,
  };
}

/** Schwab sets standard=true on weeklies. Type W is the weekly; S/M/Q are not. */
export function weeklyFromListing(
  expirationType: string | null,
  standard: boolean | null,
  fallback: boolean,
): boolean {
  const t = (expirationType ?? "").toUpperCase();
  if (t === "W") return true;
  if (t === "S" || t === "M" || t === "Q") return false;
  if (standard === false) return true;
  return fallback;
}

export function netBuys90d(
  rows: Array<{ filed: string; code: BuySell; value: number | null }>,
  today: string,
): { netValue: number; buys: number; sells: number } {
  const start = ymdAdd(today, -90);
  let netValue = 0;
  let buys = 0;
  let sells = 0;
  for (const r of rows) {
    if (r.filed < start || r.filed > today) continue;
    if (r.code === "buy") {
      buys++;
      netValue += r.value ?? 0;
    } else if (r.code === "sell") {
      sells++;
      netValue -= r.value ?? 0;
    }
  }
  return { netValue, buys, sells };
}

/** Earnings 8-Ks are not hard events for the news shortlist. */
export function isHardEvent(category: string | null, primary: string | null): boolean {
  const blob = `${category ?? ""} ${primary ?? ""}`.toLowerCase();
  if (!blob.trim()) return false;
  return !/quarterly_results|earnings_announcement|earnings/.test(blob);
}
