#!/usr/bin/env npx tsx
/**
 * A311 — log SPY/QQQ dealer GEX after the close (daily.py publish stage, soft).
 *   cd artifacts/api-server && pnpm exec tsx src/scripts/snapshot-gex-daily.ts
 */
import { etDateKey } from "../lib/market-hours.js";
import { runGexDailySnapshot } from "../lib/gex-daily.js";

async function main() {
  const asOf = etDateKey();
  const rows = await runGexDailySnapshot(asOf);
  if (!rows.length) {
    console.log(`gex-daily: 0 rows for ${asOf} (Schwab down or empty chain)`);
    return;
  }
  for (const { ticker, summary } of rows) {
    console.log(
      `gex-daily ${asOf} ${ticker}: net=${summary.netGex.toFixed(0)} call=${summary.callGex.toFixed(0)} ` +
        `put=${summary.putGex.toFixed(0)} flip=${summary.gammaFlip?.toFixed(2) ?? "—"} ` +
        `walls ${summary.callWall ?? "—"}/${summary.putWall ?? "—"} n=${summary.nContracts}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
