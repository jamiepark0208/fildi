import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';
await db.execute(sql`ALTER TABLE finnhub_fundamentals ADD COLUMN IF NOT EXISTS finnhub_dividend_yield numeric`);
console.log('Migration applied: finnhub_dividend_yield column added');
process.exit(0);
