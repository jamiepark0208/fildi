#!/usr/bin/env npx tsx
/**
 * Apply fund_score_snapshots + fund_score_notes (migration 0030).
 *   cd artifacts/api-server && npx tsx src/scripts/migrate-0030-fund-score-accountability.ts
 */
import { ensureFundScoreAccountabilityTables } from "../lib/fund-score-snapshots.js";

async function main() {
  await ensureFundScoreAccountabilityTables();
  console.log("migration 0030_fund_score_accountability applied");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
