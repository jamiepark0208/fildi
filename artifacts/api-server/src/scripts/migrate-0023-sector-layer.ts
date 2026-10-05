import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`ALTER TABLE ticker_fundamentals ADD COLUMN IF NOT EXISTS fund_company_score numeric`);
  await db.execute(sql`ALTER TABLE ticker_fundamentals ADD COLUMN IF NOT EXISTS fund_sector_score numeric`);
  console.log("migration 0023_sector_layer applied");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
