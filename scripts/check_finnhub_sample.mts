import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';
// Check how many tickers have fetch_fundamentals=true  
const r = await db.execute(sql`SELECT COUNT(*) FROM ticker_registry WHERE fetch_fundamentals = true`);
console.log('fetch_fundamentals=true tickers:', r.rows[0]);
// Check dividend yield by source
const r2 = await db.execute(sql`
  SELECT source, COUNT(*) cnt FROM field_provenance 
  WHERE field_name = 'dividendYield' GROUP BY source ORDER BY cnt DESC
`);
console.log('dividendYield by source:', r2.rows);
// Check PE provenance
const r3 = await db.execute(sql`
  SELECT source, COUNT(*) cnt FROM field_provenance 
  WHERE field_name = 'peRatio' GROUP BY source ORDER BY cnt DESC
`);
console.log('peRatio by source:', r3.rows);
process.exit(0);
