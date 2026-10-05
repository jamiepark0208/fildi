#!/usr/bin/env npx tsx
/**
 * Ingest FactSet desk .eml/.json from Google Drive → desk_commentaries.
 *
 *   cd artifacts/api-server && npx tsx src/scripts/ingest-desk-commentaries.ts
 *   npx tsx src/scripts/ingest-desk-commentaries.ts --dry-run --limit=20
 *   DESK_BRIEFS_DIR="/path/to/TradeDash Briefs" npx tsx src/scripts/ingest-desk-commentaries.ts
 *
 * Laptop closed: Apps Script still writes to Drive cloud. Run this after wake
 * (or let the API scheduler pick it up) — catch-up only, no missed-poll replay.
 */
import { ingestDeskCommentaries, getDefaultBriefsDir } from "../lib/desk-commentary.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1]!, 10) : undefined;
  const sinceArg = process.argv.find((a) => a.startsWith("--since-hours="));
  const sinceHours = sinceArg ? parseFloat(sinceArg.split("=")[1]!) : undefined;
  const sinceMs =
    sinceHours != null && Number.isFinite(sinceHours)
      ? Date.now() - sinceHours * 60 * 60 * 1000
      : undefined;

  console.log("dir:", getDefaultBriefsDir());
  const result = await ingestDeskCommentaries({ dryRun, limit, sinceMs });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
