#!/usr/bin/env npx tsx
/**
 * Apply desk_commentaries table (migration 0026).
 *   cd artifacts/api-server && npx tsx src/scripts/migrate-0026-desk-commentaries.ts
 */
import { ensureDeskCommentariesTable } from "../lib/desk-commentary.js";

async function main() {
  await ensureDeskCommentariesTable();
  console.log("migration 0026_desk_commentaries applied");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
