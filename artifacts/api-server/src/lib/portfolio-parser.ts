/**
 * Parser for Robinhood full-export CSV files.
 * Handles the multi-section format with === delimiters.
 */

export interface ParsedPortfolio {
  exportDate: string | null;
  accountIds: string[];
  totalValue: number | null;
  cashBalance: number | null;
  cryptoValue: number | null;
  accountSummaries: ParsedAccountSummary[];
  positions: ParsedPosition[];
  equityFundamentals: ParsedEquityFundamental[];
  options: ParsedOption[];
  orders: ParsedOrder[];
}

export interface ParsedAccountSummary {
  account: string;
  nickname: string | null;
  type: string | null;
  totalValue: string | null;
  equityValue: string | null;
  optionsValue: string | null;
  cryptoValue: string | null;
  eventContracts: string | null;
  cash: string | null;
  marginUsed: string | null;
  buyingPower: string | null;
  unleveragedBp: string | null;
}

export interface ParsedPosition {
  account: string;
  accountNickname: string | null;
  symbol: string;
  quantity: string | null;
  avgCost: string | null;
  lastPrice: string | null;
  extHoursPrice: string | null;
  marketValue: string | null;
  costBasis: string | null;
  unrealizedPnL: string | null;
  pnlPct: string | null;
  dayChangePct: string | null;
  bid: string | null;
  ask: string | null;
  prevClose: string | null;
}

export interface ParsedEquityFundamental {
  symbol: string;
  open: string | null;
  high: string | null;
  low: string | null;
  volume: string | null;
  avgVol2w: string | null;
  marketCap: string | null;
  peRatio: string | null;
  pbRatio: string | null;
  week52High: string | null;
  week52Low: string | null;
  sharesOutstanding: string | null;
  divPerShare: string | null;
  divYield: string | null;
  sector: string | null;
  industry: string | null;
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
  adjMark: string | null;
  currentValue: string | null;
  unrealizedPnL: string | null;
  pnlPct: string | null;
  bid: string | null;
  ask: string | null;
  prevClose: string | null;
  iv: string | null;
  delta: string | null;
  gamma: string | null;
  theta: string | null;
  vega: string | null;
  openInterest: string | null;
  volume: string | null;
}

export interface ParsedOrder {
  orderId: string | null;
  account: string;
  symbol: string;
  side: string | null;
  orderType: string | null;
  state: string | null;
  quantity: string | null;
  cumulativeQty: string | null;
  processedQty: string | null;
  canceledQty: string | null;
  limitPrice: string | null;
  stopPrice: string | null;
  avgFillPrice: string | null;
  premium: string | null;
  processedPremium: string | null;
  fees: string | null;
  timeInForce: string | null;
  marketHours: string | null;
  placedAgent: string | null;
  createdAt: string | null;
  lastTransactionAt: string | null;
  isOption: boolean;
  optionStrike: string | null;
  optionExpiration: string | null;
  optionSide: string | null;
  legSide: string | null;
  legEffect: string | null;
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

function parseAccountSummary(rows: string[][]): {
  accountIds: string[]; totalValue: number | null; cashBalance: number | null;
  cryptoValue: number | null; accountSummaries: ParsedAccountSummary[];
} {
  const accountIds: string[] = [];
  const accountSummaries: ParsedAccountSummary[] = [];
  let totalValue: number | null = null;
  let cashTotal = 0;
  let cryptoTotal = 0;
  let sawAccountRow = false;
  // header: Account,Nickname,Type,Total Value,Equity Value,Options Value,Crypto Value,Event Contracts,Cash,Margin Used,Buying Power,Unleveraged BP
  for (const cols of rows) {
    if (!cols[0] || cols[0] === 'Account') continue;
    if (cols[0].toUpperCase() === 'COMBINED') {
      const v = parseFloat(cols[3] ?? '');
      if (!isNaN(v)) totalValue = v;
    } else {
      accountIds.push(cols[0].trim());
      accountSummaries.push({
        account:        cols[0].trim(),
        nickname:       clean(cols[1]),
        type:           clean(cols[2]),
        totalValue:     clean(cols[3]),
        equityValue:    clean(cols[4]),
        optionsValue:   clean(cols[5]),
        cryptoValue:    clean(cols[6]),
        eventContracts: clean(cols[7]),
        cash:           clean(cols[8]),
        marginUsed:     clean(cols[9]),
        buyingPower:    clean(cols[10]),
        unleveragedBp:  clean(cols[11]),
      });
      const cash = parseFloat(cols[8] ?? '');
      if (!isNaN(cash)) { cashTotal += cash; sawAccountRow = true; }
      const crypto = parseFloat(cols[6] ?? '');
      if (!isNaN(crypto)) cryptoTotal += crypto;
    }
  }
  return {
    accountIds, totalValue,
    cashBalance: sawAccountRow ? cashTotal : null,
    cryptoValue: sawAccountRow ? cryptoTotal : null,
    accountSummaries,
  };
}

function parseEquityPositions(rows: string[][]): ParsedPosition[] {
  const out: ParsedPosition[] = [];
  // header: Account,Symbol,Quantity,Avg Cost,Last Price,Ext Hours Price,Market Value,Cost Basis,Unrealized P&L,P&L %,Day Change %,Bid,Ask,Prev Close
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
      extHoursPrice: clean(cols[5]),
      marketValue:   clean(cols[6]),
      costBasis:     clean(cols[7]),
      unrealizedPnL: clean(cols[8]),
      pnlPct:        clean(cols[9]),
      dayChangePct:  clean(cols[10]),
      bid:           clean(cols[11]),
      ask:           clean(cols[12]),
      prevClose:     clean(cols[13]),
    });
  }
  return out;
}

function parseEquityFundamentals(rows: string[][]): ParsedEquityFundamental[] {
  const out: ParsedEquityFundamental[] = [];
  // header: Symbol,Open,High,Low,Volume,Avg Vol 2W,Market Cap,P/E,P/B,52W High,52W Low,Shares Outstanding,Div/Share,Div Yield,Sector,Industry
  for (const cols of rows) {
    if (!cols[0] || cols[0] === 'Symbol') continue;
    const symbol = cols[0]?.trim();
    if (!symbol) continue;
    out.push({
      symbol,
      open:              clean(cols[1]),
      high:              clean(cols[2]),
      low:               clean(cols[3]),
      volume:            clean(cols[4]),
      avgVol2w:          clean(cols[5]),
      marketCap:         clean(cols[6]),
      peRatio:           clean(cols[7]),
      pbRatio:           clean(cols[8]),
      week52High:        clean(cols[9]),
      week52Low:         clean(cols[10]),
      sharesOutstanding: clean(cols[11]),
      divPerShare:       clean(cols[12]),
      divYield:          clean(cols[13]),
      sector:            clean(cols[14]),
      industry:          clean(cols[15]),
    });
  }
  return out;
}

function parseOptionPositions(rows: string[][]): ParsedOption[] {
  const out: ParsedOption[] = [];
  // header: Account,Symbol,Type,Strike,Expiration,Direction,Qty,Avg Premium,Total Premium,Mark Price,Adj Mark,
  //         Current Value (per contract),Unrealized P&L (total),P&L %,Bid,Ask,Prev Close,IV,Delta,Gamma,Theta,Vega,Open Interest,Volume
  for (const cols of rows) {
    if (!cols[0] || cols[0] === 'Account') continue;
    const { account } = parseAccountCell(cols[0]);
    const symbol = cols[1]?.trim();
    if (!symbol) continue;
    out.push({
      account,
      symbol,
      optionType:    clean(cols[2])?.toLowerCase() ?? null,
      strike:        clean(cols[3]),
      expiration:    clean(cols[4]),
      direction:     clean(cols[5])?.toLowerCase() ?? null,
      qty:           clean(cols[6]),
      avgPremium:    clean(cols[7]),
      totalPremium:  clean(cols[8]),
      markPrice:     clean(cols[9]),
      adjMark:       clean(cols[10]),
      currentValue:  clean(cols[11]),
      unrealizedPnL: clean(cols[12]),
      pnlPct:        clean(cols[13]),
      bid:           clean(cols[14]),
      ask:           clean(cols[15]),
      prevClose:     clean(cols[16]),
      iv:            clean(cols[17]),
      delta:         clean(cols[18]),
      gamma:         clean(cols[19]),
      theta:         clean(cols[20]),
      vega:          clean(cols[21]),
      openInterest:  clean(cols[22]),
      volume:        clean(cols[23]),
    });
  }
  return out;
}

function parseEquityOrders(rows: string[][], accountId: string): ParsedOrder[] {
  const out: ParsedOrder[] = [];
  // header: Order ID,Symbol,Side,Type,State,Quantity,Cumulative Qty,Limit Price,Stop Price,Avg Fill Price,Fees,Time in Force,Market Hours,Placed Agent,Created At,Last Transaction At
  for (const cols of rows) {
    if (!cols[0] || cols[0] === 'Order ID') continue;
    const symbol = cols[1]?.trim();
    if (!symbol) continue;
    out.push({
      orderId:          clean(cols[0]),
      account:          accountId,
      symbol,
      side:             clean(cols[2]),
      orderType:        clean(cols[3]),
      state:            clean(cols[4]),
      quantity:         clean(cols[5]),
      cumulativeQty:    clean(cols[6]),
      processedQty:     null,
      canceledQty:      null,
      limitPrice:       clean(cols[7]),
      stopPrice:        clean(cols[8]),
      avgFillPrice:     clean(cols[9]),
      premium:          null,
      processedPremium: null,
      fees:             clean(cols[10]),
      timeInForce:      clean(cols[11]),
      marketHours:      clean(cols[12]),
      placedAgent:      clean(cols[13]),
      createdAt:        clean(cols[14]),
      lastTransactionAt: clean(cols[15]),
      isOption:         false,
      optionStrike:     null,
      optionExpiration: null,
      optionSide:       null,
      legSide:          null,
      legEffect:        null,
    });
  }
  return out;
}

function parseOptionOrders(rows: string[][], accountId: string): ParsedOrder[] {
  const out: ParsedOrder[] = [];
  // header: Order ID,Symbol,Direction,State,Strategy,Quantity,Processed Qty,Canceled Qty,Price,Premium,Processed Premium,
  //         Time in Force,Market Hours,Placed Agent,Created At,Last Transaction At,Leg Type,Leg Strike,Leg Expiration,Leg Side,Leg Effect
  for (const cols of rows) {
    if (!cols[0] || cols[0] === 'Order ID') continue;
    const symbol = cols[1]?.trim();
    if (!symbol) continue;
    out.push({
      orderId:          clean(cols[0]),
      account:          accountId,
      symbol,
      side:             clean(cols[2]),   // debit | credit
      orderType:        clean(cols[4]),   // strategy e.g. short_put
      state:            clean(cols[3]),
      quantity:         clean(cols[5]),
      cumulativeQty:    null,
      processedQty:     clean(cols[6]),
      canceledQty:      clean(cols[7]),
      limitPrice:       null,
      stopPrice:        null,
      avgFillPrice:     clean(cols[8]),   // per-contract price
      premium:          clean(cols[9]),
      processedPremium: clean(cols[10]),
      fees:             null,
      timeInForce:      clean(cols[11]),
      marketHours:      clean(cols[12]),
      placedAgent:      clean(cols[13]),
      createdAt:        clean(cols[14]),
      lastTransactionAt: clean(cols[15]),
      isOption:         true,
      optionStrike:     clean(cols[17]),
      optionExpiration: clean(cols[18]),
      optionSide:       clean(cols[16]),  // call | put
      legSide:          clean(cols[19]),  // buy | sell
      legEffect:        clean(cols[20]),  // open | close
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
  let cashBalance: number | null = null;
  let cryptoValue: number | null = null;
  let accountSummaries: ParsedAccountSummary[] = [];
  const positions: ParsedPosition[] = [];
  const equityFundamentals: ParsedEquityFundamental[] = [];
  const options: ParsedOption[] = [];
  const orders: ParsedOrder[] = [];

  for (const section of sections) {
    const rows = section.lines
      .map(l => parseCsvLine(l))
      .filter(cols => cols.some(c => c !== ''));

    switch (section.kind) {
      case 'account_summary': {
        const r = parseAccountSummary(rows);
        accountIds = r.accountIds;
        totalValue = r.totalValue;
        cashBalance = r.cashBalance;
        cryptoValue = r.cryptoValue;
        accountSummaries = r.accountSummaries;
        break;
      }
      case 'equity_positions':
        positions.push(...parseEquityPositions(rows));
        break;
      case 'equity_fundamentals':
        equityFundamentals.push(...parseEquityFundamentals(rows));
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

  return {
    exportDate, accountIds, totalValue, cashBalance, cryptoValue, accountSummaries,
    positions, equityFundamentals, options, orders,
  };
}
