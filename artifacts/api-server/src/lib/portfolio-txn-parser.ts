/**
 * Parsers for the two newer export shapes from export_rbh_transactions.py /
 * export_ticker_earnings.py, which are NOT the multi-section Robinhood holdings
 * format handled by portfolio-parser.ts:
 *  - flat transactions CSV (both the "recent" and "cumulative" exports share
 *    this exact shape — only row count differs)
 *  - ticker-earnings-summary CSV (per-account sections + a TOTAL footer row)
 */

import { parseCsvLine } from './portfolio-parser.js';

export interface ParsedTransaction {
  txnId: string;
  account: string;
  symbol: string;
  txnType: string | null;
  category: string | null;
  side: string | null;
  quantity: string | null;
  price: string | null;
  amount: string | null;
  txnDate: string | null;
  source: string | null;
  confidence: string | null;
}

export interface ParsedTickerEarning {
  account: string;
  ticker: string;
  totalUnrealized: string | null;
  totalRealized: string | null;
  totalEarned: string | null;
  sellPut: string | null;
  sellCall: string | null;
  longCall: string | null;
  longPut: string | null;
  dividends: string | null;
  stocksRealized: string | null;
  stocksUnrealized: string | null;
  totalStocks: string | null;
}

function clean(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  return s === '' ? null : s;
}

const TXN_HEADER = 'txn_id,account,symbol,txn_type,category,side,quantity,price,amount,date,source,confidence';

/** Content-sniff: does this look like the flat transactions export? */
export function isTransactionsCSV(csvText: string): boolean {
  const firstLine = csvText.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return firstLine.replace(/\s+/g, '') === TXN_HEADER.replace(/\s+/g, '');
}

export function parseTransactionsCSV(csvText: string): ParsedTransaction[] {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
  const out: ParsedTransaction[] = [];
  for (const line of lines) {
    const cols = parseCsvLine(line);
    if (!cols[0] || cols[0] === 'txn_id') continue;
    out.push({
      txnId:      cols[0],
      account:    cols[1],
      symbol:     cols[2],
      txnType:    clean(cols[3]),
      category:   clean(cols[4]),
      side:       clean(cols[5]),
      quantity:   clean(cols[6]),
      price:      clean(cols[7]),
      amount:     clean(cols[8]),
      txnDate:    clean(cols[9]),
      source:     clean(cols[10]),
      confidence: clean(cols[11]),
    });
  }
  return out;
}

const EARNINGS_TITLE = 'Ticker Earnings Summary';

/** Content-sniff: does this look like the ticker-earnings-summary export? */
export function isTickerEarningsCSV(csvText: string): boolean {
  return csvText.trimStart().startsWith(EARNINGS_TITLE);
}

/** "=== FILDI (5QU47796) ===,,,,,,,,,,," → "FILDI" */
function accountFromSectionHeader(line: string): string {
  const inner = line.replace(/^"?===\s*/, '').replace(/\s*===.*$/, '').trim();
  const m = inner.match(/^(.*?)\s*\(/);
  return (m ? m[1] : inner).trim();
}

export function parseTickerEarningsCSV(csvText: string): ParsedTickerEarning[] {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
  const out: ParsedTickerEarning[] = [];
  let currentAccount: string | null = null;
  let inTable = false;

  for (const raw of lines) {
    const line = raw.replace(/^"/, '');
    if (line.startsWith('===') || line.startsWith('"===')) {
      currentAccount = accountFromSectionHeader(line);
      inTable = false;
      continue;
    }
    const cols = parseCsvLine(raw);
    if (cols[0] === 'Ticker') { inTable = true; continue; }
    if (!inTable || !currentAccount) continue;
    if (!cols[0] || cols[0] === 'TOTAL') { inTable = false; continue; }
    // Footer note rows, e.g. "  (includes $2000.00 cash bonus, not ticker-specific)"
    if (cols[0].trim().startsWith('(')) continue;

    out.push({
      account:          currentAccount,
      ticker:           cols[0],
      totalUnrealized:  clean(cols[1]),
      totalRealized:    clean(cols[2]),
      totalEarned:      clean(cols[3]),
      sellPut:          clean(cols[4]),
      sellCall:         clean(cols[5]),
      longCall:         clean(cols[6]),
      longPut:          clean(cols[7]),
      dividends:        clean(cols[8]),
      stocksRealized:   clean(cols[9]),
      stocksUnrealized: clean(cols[10]),
      totalStocks:      clean(cols[11]),
    });
  }
  return out;
}
