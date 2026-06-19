/**
 * Parser for Robinhood full-export CSV files.
 * Handles the multi-section format with === delimiters.
 */

export interface ParsedPortfolio {
  exportDate: string | null;
  accountIds: string[];
  totalValue: number | null;
  positions: ParsedPosition[];
  options: ParsedOption[];
  orders: ParsedOrder[];
}

export interface ParsedPosition {
  account: string;
  accountNickname: string | null;
  symbol: string;
  quantity: string | null;
  avgCost: string | null;
  lastPrice: string | null;
  marketValue: string | null;
  costBasis: string | null;
  unrealizedPnL: string | null;
  pnlPct: string | null;
  dayChangePct: string | null;
  bid: string | null;
  ask: string | null;
}

export interface ParsedOption {
  account: string;
  symbol: string;
  optionType: string | null;
  strike: string | null;
  expiration: string | null;
  direction: string | null;
  qty: string | null;
  avgPremium: string | null;
  totalPremium: string | null;
  markPrice: string | null;
  unrealizedPnL: string | null;
  pnlPct: string | null;
  iv: string | null;
  delta: string | null;
  gamma: string | null;
  theta: string | null;
  vega: string | null;
}

export interface ParsedOrder {
  account: string;
  symbol: string;
  side: string | null;
  orderType: string | null;
  state: string | null;
  quantity: string | null;
  avgFillPrice: string | null;
  createdAt: string | null;
  isOption: boolean;
  optionStrike: string | null;
  optionExpiration: string | null;
  optionSide: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

/** "14.59%" → "14.59"; "N/A" → null; "" → null */
function clean(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.trim().replace(/%$/, '');
  if (s === '' || s === 'N/A' || s === 'n/a') return null;
  return s;
}

/** "FILDI (5QU47796)" → { account: "5QU47796", accountNickname: "FILDI" } */
function parseAccountCell(raw: string): { account: string; accountNickname: string | null } {
  const m = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return { account: m[2].trim(), accountNickname: m[1].trim() || null };
  return { account: raw.trim(), accountNickname: null };
}

/** "=== EQUITY ORDERS — FILDI (5QU47796) ===" → "5QU47796" */
function accountIdFromSectionHeader(header: string): string {
  const m = header.match(/\(([^)]+)\)/);
  return m ? m[1].trim() : '';
}

type SectionKind =
  | 'account_summary'
  | 'equity_positions'
  | 'equity_fundamentals'
  | 'option_positions'
  | 'equity_orders'
  | 'option_orders'
  | null;

function detectSection(line: string): { kind: SectionKind; accountId: string } | null {
  if (!line.startsWith('===')) return null;
  const normalized = line.replace(/^===\s*/, '').replace(/\s*===.*$/, '').trim();
  if (normalized.startsWith('ACCOUNT SUMMARY'))        return { kind: 'account_summary',       accountId: '' };
  if (normalized.startsWith('EQUITY POSITIONS'))       return { kind: 'equity_positions',       accountId: '' };
  if (normalized.startsWith('EQUITY FUNDAMENTALS'))    return { kind: 'equity_fundamentals',    accountId: '' };
  if (normalized.startsWith('OPTION POSITIONS'))       return { kind: 'option_positions',       accountId: '' };
  if (normalized.startsWith('EQUITY ORDERS'))          return { kind: 'equity_orders',          accountId: accountIdFromSectionHeader(line) };
  if (normalized.startsWith('OPTION ORDERS'))          return { kind: 'option_orders',          accountId: accountIdFromSectionHeader(line) };
  return null;
}

// ── Section parsers ───────────────────────────────────────────────────────────

function parseAccountSummary(rows: string[][]): { accountIds: string[]; totalValue: number | null } {
  const accountIds: string[] = [];
  let totalValue: number | null = null;
  for (const cols of rows) {
    if (!cols[0] || cols[0] === 'Account') continue;
    if (cols[0].toUpperCase() === 'COMBINED') {
      const v = parseFloat(cols[3] ?? '');
      if (!isNaN(v)) totalValue = v;
    } else {
      accountIds.push(cols[0].trim());
    }
  }
  return { accountIds, totalValue };
}

function parseEquityPositions(rows: string[][]): ParsedPosition[] {
  const out: ParsedPosition[] = [];
  for (const cols of rows) {
    if (!cols[0] || cols[0] === 'Account') continue;
    const { account, accountNickname } = parseAccountCell(cols[0]);
    const symbol = cols[1]?.trim();
    if (!symbol) continue;
    out.push({
      account,
      accountNickname,
      symbol,
      quantity:      clean(cols[2]),
      avgCost:       clean(cols[3]),
      lastPrice:     clean(cols[4]),
      marketValue:   clean(cols[6]),
      costBasis:     clean(cols[7]),
      unrealizedPnL: clean(cols[8]),
      pnlPct:        clean(cols[9]),
      dayChangePct:  clean(cols[10]),
      bid:           clean(cols[11]),
      ask:           clean(cols[12]),
    });
  }
  return out;
}

function parseOptionPositions(rows: string[][]): ParsedOption[] {
  const out: ParsedOption[] = [];
  for (const cols of rows) {
    if (!cols[0] || cols[0] === 'Account') continue;
    const { account } = parseAccountCell(cols[0]);
    const symbol = cols[1]?.trim();
    if (!symbol) continue;
    out.push({
      account,
      symbol,
      optionType:    clean(cols[2]),
      strike:        clean(cols[3]),
      expiration:    clean(cols[4]),
      direction:     clean(cols[5]),
      qty:           clean(cols[6]),
      avgPremium:    clean(cols[7]),
      totalPremium:  clean(cols[8]),
      markPrice:     clean(cols[9]),
      unrealizedPnL: clean(cols[12]),
      pnlPct:        clean(cols[13]),
      iv:            clean(cols[17]),
      delta:         clean(cols[18]),
      gamma:         clean(cols[19]),
      theta:         clean(cols[20]),
      vega:          clean(cols[21]),
    });
  }
  return out;
}

function parseEquityOrders(rows: string[][], accountId: string): ParsedOrder[] {
  const out: ParsedOrder[] = [];
  for (const cols of rows) {
    // header: Order ID,Symbol,Side,Type,State,Quantity,...,Avg Fill Price,...,Created At
    if (!cols[0] || cols[0] === 'Order ID') continue;
    const symbol = cols[1]?.trim();
    if (!symbol) continue;
    out.push({
      account:         accountId,
      symbol,
      side:            clean(cols[2]),
      orderType:       clean(cols[3]),
      state:           clean(cols[4]),
      quantity:        clean(cols[5]),
      avgFillPrice:    clean(cols[9]),
      createdAt:       clean(cols[14]),
      isOption:        false,
      optionStrike:    null,
      optionExpiration: null,
      optionSide:      null,
    });
  }
  return out;
}

function parseOptionOrders(rows: string[][], accountId: string): ParsedOrder[] {
  const out: ParsedOrder[] = [];
  for (const cols of rows) {
    // header: Order ID,Symbol,Direction,State,Strategy,Quantity,...,Price,...,Created At,...,Leg Type,Leg Strike,Leg Expiration,Leg Side,Leg Effect
    if (!cols[0] || cols[0] === 'Order ID') continue;
    const symbol = cols[1]?.trim();
    if (!symbol) continue;
    out.push({
      account:          accountId,
      symbol,
      side:             clean(cols[2]),   // debit | credit
      orderType:        clean(cols[4]),   // strategy e.g. short_put
      state:            clean(cols[3]),
      quantity:         clean(cols[5]),
      avgFillPrice:     clean(cols[8]),   // per-contract price
      createdAt:        clean(cols[14]),
      isOption:         true,
      optionStrike:     clean(cols[17]),
      optionExpiration: clean(cols[18]),
      optionSide:       clean(cols[16]),  // call | put
    });
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function parseRobinhoodCSV(csvText: string): ParsedPortfolio {
  const rawLines = csvText.split(/\r?\n/);

  // Extract export date from first line: "Robinhood Full Export — 2026-06-17 15:05"
  let exportDate: string | null = null;
  const dateMatch = rawLines[0]?.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) exportDate = dateMatch[1];

  // Split into sections
  type Section = { kind: SectionKind; accountId: string; lines: string[] };
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of rawLines) {
    const stripped = line.replace(/,+$/, '').trim();
    const detected = detectSection(stripped);
    if (detected) {
      if (current) sections.push(current);
      current = { kind: detected.kind, accountId: detected.accountId, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  // Parse each section
  let accountIds: string[] = [];
  let totalValue: number | null = null;
  const positions: ParsedPosition[] = [];
  const options: ParsedOption[] = [];
  const orders: ParsedOrder[] = [];

  for (const section of sections) {
    if (section.kind === 'equity_fundamentals') continue;
    const rows = section.lines
      .map(l => parseCsvLine(l))
      .filter(cols => cols.some(c => c !== ''));

    switch (section.kind) {
      case 'account_summary': {
        const r = parseAccountSummary(rows);
        accountIds = r.accountIds;
        totalValue = r.totalValue;
        break;
      }
      case 'equity_positions':
        positions.push(...parseEquityPositions(rows));
        break;
      case 'option_positions':
        options.push(...parseOptionPositions(rows));
        break;
      case 'equity_orders':
        orders.push(...parseEquityOrders(rows, section.accountId));
        break;
      case 'option_orders':
        orders.push(...parseOptionOrders(rows, section.accountId));
        break;
    }
  }

  return { exportDate, accountIds, totalValue, positions, options, orders };
}
