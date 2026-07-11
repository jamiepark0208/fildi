/**
 * One-time ad hoc backfill: insert missing YTD orders from a Robinhood
 * "Orders Export (Ad Hoc)" CSV into the existing latest portfolio_snapshots
 * row. This CSV only has order sections (no positions/account summary), so
 * we reuse parseRobinhoodCSV purely for its order-section parsing and skip
 * everything else. Dedupes against existing order_id values already
 * attached to the target snapshot so re-running is safe.
 *
 * Run: cd artifacts/api-server && tsx src/scripts/backfill-ytd-orders.ts <path-to-csv>
 */

import fs from "node:fs";
import { eq } from "drizzle-orm";
import { db, portfolioSnapshots, portfolioOrders } from "@workspace/db";
import { parseRobinhoodCSV } from "../lib/portfolio-parser.js";

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("Usage: tsx src/scripts/backfill-ytd-orders.ts <path-to-csv>");
    process.exit(1);
  }

  const csvText = fs.readFileSync(csvPath, "utf8");
  const parsed = parseRobinhoodCSV(csvText);

  console.log(`Parsed ${parsed.orders.length} orders from ${csvPath}`);

  const snapshotRows = await db.select().from(portfolioSnapshots);
  const target = snapshotRows.sort(
    (a, b) => new Date(b.importedAt).getTime() - new Date(a.importedAt).getTime()
  )[0];

  if (!target) {
    console.error("No portfolio_snapshots row found — cannot attach orders.");
    process.exit(1);
  }

  console.log(`Target snapshot id=${target.id} importedAt=${target.importedAt}`);

  const existing = await db
    .select({ orderId: portfolioOrders.orderId })
    .from(portfolioOrders)
    .where(eq(portfolioOrders.snapshotId, target.id));

  const existingIds = new Set(existing.map(r => r.orderId).filter((v): v is string => v != null));
  console.log(`Snapshot ${target.id} already has ${existingIds.size} orders`);

  const toInsert = parsed.orders.filter(o => o.orderId && !existingIds.has(o.orderId));
  console.log(`Inserting ${toInsert.length} new orders (skipping ${parsed.orders.length - toInsert.length} already present)`);

  if (toInsert.length === 0) {
    console.log("Nothing to insert. Done.");
    return;
  }

  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    await db.insert(portfolioOrders).values(
      batch.map(ord => ({
        snapshotId: target.id,
        orderId: ord.orderId,
        account: ord.account,
        symbol: ord.symbol,
        side: ord.side,
        orderType: ord.orderType,
        state: ord.state,
        quantity: ord.quantity,
        cumulativeQty: ord.cumulativeQty,
        processedQty: ord.processedQty,
        canceledQty: ord.canceledQty,
        limitPrice: ord.limitPrice,
        stopPrice: ord.stopPrice,
        avgFillPrice: ord.avgFillPrice,
        premium: ord.premium,
        processedPremium: ord.processedPremium,
        fees: ord.fees,
        timeInForce: ord.timeInForce,
        marketHours: ord.marketHours,
        placedAgent: ord.placedAgent,
        createdAt: ord.createdAt ? new Date(ord.createdAt) : null,
        lastTransactionAt: ord.lastTransactionAt ? new Date(ord.lastTransactionAt) : null,
        isOption: ord.isOption,
        optionStrike: ord.optionStrike,
        optionExpiration: ord.optionExpiration,
        optionSide: ord.optionSide,
        legSide: ord.legSide,
        legEffect: ord.legEffect,
      }))
    );
    inserted += batch.length;
    console.log(`  inserted ${inserted}/${toInsert.length}`);
  }

  console.log(`Done. Inserted ${inserted} orders into snapshot ${target.id}.`);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
