/**
 * Apply 0028 desk ingest v2 columns + feedback table.
 *   cd artifacts/api-server && npx tsx src/scripts/migrate-0028-desk-ingest-v2.ts
 */
import { ensureDeskCommentariesTable } from "../lib/desk-commentary.js";

await ensureDeskCommentariesTable();
console.log("0028 desk ingest v2 columns + desk_news_feedback ready");
process.exit(0);
