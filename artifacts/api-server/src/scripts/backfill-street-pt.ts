/** A86 — rebuild street_pt_daily from analyst_events. */
import { backfillStreetPtFromEvents } from "../lib/street-pt.js";

async function main(): Promise<void> {
  const n = await backfillStreetPtFromEvents();
  console.log(JSON.stringify({ rows: n }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
