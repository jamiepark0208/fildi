/**
 * One-time ad hoc backfill: insert the estimated/reconstructed rows from the
 * "Full YTD Export incl. Estimates" CSV that don't come from Robinhood's order
 * API — option-assignment stock lots, dividend payments, and a one-off cash
 * bonus — into portfolio_orders alongside the regular order rows. Also
 * re-runs the regular equity/option order sections through the existing
 * dedupe-by-order-id path in case this fuller export has any new fills.
 *
 * Non-order rows reuse portfolio_orders' amount/source/confidence columns
 * (added by this migration) rather than a separate table:
 *   - assignment: side='buy'|'sell', orderType='assignment', quantity/avgFillPrice
 *     set so the existing FIFO stock-lot matching in realized-pnl.ts picks it up.
 *   - dividend:   orderType='dividend', quantity=shares held, avgFillPrice=div/share,
 *     amount=total cash.
 *   - cash_bonus: orderType='cash_bonus', symbol=null, amount=total cash.
 *
 * Run: cd artifacts/api-server && tsx src/scripts/backfill-dividends-assignments-cashbonus.ts <path-to-csv>
 */

import fs from "node:fs";
import { and, eq, isNull } from "drizzle-orm";
import { db, portfolioSnapshots, portfolioOrders } from "@workspace/db";
import { parseRobinhoodCSV, parseCsvLine } from "../lib/portfolio-parser.js";

const ACCOUNT_ID: Record<string, string> = {
  FILDI: "5QU47796",
  IRA: "772445425",
};

type NewRow = {
  account: string; symbol: string | null; side: string | null; orderType: string;
  quantity: string | null; avgFillPrice: string | null; amount: string | null;
  createdAt: Date; source: string | null; confidence: string | null;
};

function extractSection(csvText: string, startMarker: string, endMarker: string | null): string[] {
  const lines = csvText.split(/\r?\n/);
  const startIdx = lines.findIndex(l => l.includes(startMarker));
  if (startIdx === -1) return [];
  const afterStart = lines.slice(startIdx + 2); // skip header line + column-names line
  const endIdx = endMarker ? afterStart.findIndex(l => l.includes(endMarker)) : -1;
  const body = endIdx === -1 ? afterStart : afterStart.slice(0, endIdx);
  return body.map(l => l.trim()).filter(l => l.length > 0);
}

function parseAssignments(csvText: string): NewRow[] {
  const rows = extractSection(csvText, "ASSIGNMENT TRANSACTIONS", "DIVIDEND TRANSACTIONS");
  return rows.map(line => {
    const [account, symbol, side, qty, price, date, txnType, source] = parseCsvLine(line);
    return {
      account: ACCOUNT_ID[account] ?? account, symbol, side,
      orderType: "assignment",
      quantity: qty, avgFillPrice: price, amount: null,
      createdAt: new Date(`${date}T16:00:00Z`),
      source: `${txnType} — ${source}`, confidence: null,
    };
  });
}

function parseDividends(csvText: string): NewRow[] {
  const rows = extractSection(csvText, "DIVIDEND TRANSACTIONS", "CASH EVENTS");
  return rows.map(line => {
    const [account, symbol, recordDate, sharesHeld, divPerShare, amount, source, confidence] = parseCsvLine(line);
    return {
      account: ACCOUNT_ID[account] ?? account, symbol, side: null,
      orderType: "dividend",
      quantity: sharesHeld, avgFillPrice: divPerShare, amount,
      createdAt: new Date(`${recordDate}T16:00:00Z`),
      source, confidence,
    };
  });
}

function parseCashEvents(csvText: string): NewRow[] {
  const rows = extractSection(csvText, "CASH EVENTS", "SUMMARY");
  return rows.map(line => {
    const [account, description, amount, approxDate, source, confidence] = parseCsvLine(line);
    return {
      account: ACCOUNT_ID[account] ?? account, symbol: null, side: null,
      orderType: "cash_bonus",
      quantity: null, avgFillPrice: null, amount,
      createdAt: new Date(`${approxDate}T16:00:00Z`),
      source: `${description} (${source})`, confidence,
    };
  });
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("Usage: tsx src/scripts/backfill-dividends-assignments-cashbonus.ts <path-to-csv>");
    process.exit(1);
  }

  const csvText = fs.readFileSync(csvPath, "utf8");

  const snapshotRows = await db.select().from(portfolioSnapshots);
  const target = snapshotRows.sort(
    (a, b) => new Date(b.importedAt).getTime() - new Date(a.importedAt).getTime()
  )[0];
  if (!target) {
    console.error("No portfolio_snapshots row found — cannot attach rows.");
    process.exit(1);
  }
  console.log(`Target snapshot id=${target.id} importedAt=${target.importedAt}`);

  // ── 1. Regular order sections — reuse the existing dedupe-by-order-id path ──
  const parsed = parseRobinhoodCSV(csvText);
  console.log(`Parsed ${parsed.orders.length} regular orders from CSV`);

  const existingOrderIds = await db
    .select({ orderId: portfolioOrders.orderId })
    .from(portfolioOrders)
    .where(eq(portfolioOrders.snapshotId, target.id));
  const existingIdSet = new Set(existingOrderIds.map(r => r.orderId).filter((v): v is string => v != null));

  const newOrders = parsed.orders.filter(o => o.orderId && !existingIdSet.has(o.orderId));
  console.log(`  ${newOrders.length} new regular orders (skipping ${parsed.orders.length - newOrders.length} already present)`);

  for (const ord of newOrders) {
    await db.insert(portfolioOrders).values({
      snapshotId: target.id, orderId: ord.orderId, account: ord.account, symbol: ord.symbol,
      side: ord.side, orderType: ord.orderType, state: ord.state, quantity: ord.quantity,
      cumulativeQty: ord.cumulativeQty, processedQty: ord.processedQty, canceledQty: ord.canceledQty,
      limitPrice: ord.limitPrice, stopPrice: ord.stopPrice, avgFillPrice: ord.avgFillPrice,
      premium: ord.premium, processedPremium: ord.processedPremium, fees: ord.fees,
      timeInForce: ord.timeInForce, marketHours: ord.marketHours, placedAgent: ord.placedAgent,
      createdAt: ord.createdAt ? new Date(ord.createdAt) : null,
      lastTransactionAt: ord.lastTransactionAt ? new Date(ord.lastTransactionAt) : null,
      isOption: ord.isOption, optionStrike: ord.optionStrike, optionExpiration: ord.optionExpiration,
      optionSide: ord.optionSide, legSide: ord.legSide, legEffect: ord.legEffect,
    });
  }

  // ── 2. Assignment / dividend / cash-bonus rows — no order_id, dedupe by natural key ──
  const newRows = [...parseAssignments(csvText), ...parseDividends(csvText), ...parseCashEvents(csvText)];
  console.log(`Parsed ${newRows.length} assignment/dividend/cash-bonus rows from CSV`);

  const existingNonOrderRows = await db
    .select({
      account: portfolioOrders.account, symbol: portfolioOrders.symbol, orderType: portfolioOrders.orderType,
      createdAt: portfolioOrders.createdAt, amount: portfolioOrders.amount, avgFillPrice: portfolioOrders.avgFillPrice,
    })
    .from(portfolioOrders)
    .where(and(eq(portfolioOrders.snapshotId, target.id), isNull(portfolioOrders.orderId)));

  const existingKeys = new Set(existingNonOrderRows.map(r =>
    `${r.account}::${r.symbol}::${r.orderType}::${r.createdAt?.toISOString()}::${r.amount}::${r.avgFillPrice}`
  ));

  let inserted = 0;
  for (const row of newRows) {
    const key = `${row.account}::${row.symbol}::${row.orderType}::${row.createdAt.toISOString()}::${row.amount}::${row.avgFillPrice}`;
    if (existingKeys.has(key)) continue;
    await db.insert(portfolioOrders).values({
      snapshotId: target.id, orderId: null, account: row.account, symbol: row.symbol ?? "(cash bonus)",
      side: row.side, orderType: row.orderType, state: "filled",
      quantity: row.quantity, avgFillPrice: row.avgFillPrice, amount: row.amount,
      fees: "0", isOption: false, createdAt: row.createdAt, lastTransactionAt: row.createdAt,
      source: row.source, confidence: row.confidence,
    });
    inserted++;
  }

  console.log(`Inserted ${inserted} new assignment/dividend/cash-bonus rows (skipping ${newRows.length - inserted} already present).`);
  console.log("Done.");
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
