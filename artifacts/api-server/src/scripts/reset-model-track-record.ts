/**
 * Wipe model_recs + hotlist_snapshots and reset tilt/calibration so policy v2
 * starts on a clean slate. Run after deploying calibration + multi-knob policy.
 *
 *   cd artifacts/api-server && npx tsx src/scripts/reset-model-track-record.ts
 *   npx tsx src/scripts/reset-model-track-record.ts --snapshot   # wipe then snapshot
 */
import { resetModelTrackRecord, runModelSnapshot, recomputeTilt } from "../lib/model-track-record.js";

async function main() {
  const wantSnapshot = process.argv.includes("--snapshot");
  const result = await resetModelTrackRecord();
  console.log(JSON.stringify({ reset: result }, null, 2));
  await recomputeTilt();
  if (wantSnapshot) {
    const snap = await runModelSnapshot();
    console.log(JSON.stringify({ snapshot: snap }, null, 2));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
