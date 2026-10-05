#!/usr/bin/env npx tsx
/**
 * Backfill earnings_days_out from earnings_calendar (DB-only, no Yahoo).
 *   cd artifacts/api-server && npx tsx src/scripts/backfill-earnings-days-out.ts
 */
import { backfillEarningsDaysOut } from "../lib/technicals-db.js";

async function main() {
  const r = await backfillEarningsDaysOut();
  console.log(JSON.stringify({ ok: true, ...r }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
