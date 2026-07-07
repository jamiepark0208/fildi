import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';
// Dividend yield by winning source
const r2 = await db.execute(sql`
  SELECT winning_source, COUNT(*) cnt FROM field_provenance 
  WHERE field = 'dividendYield' GROUP BY winning_source ORDER BY cnt DESC
`);
console.log('dividendYield by source:', r2.rows);
// PE by winning source
const r3 = await db.execute(sql`
  SELECT winning_source, COUNT(*) cnt FROM field_provenance 
  WHERE field = 'peRatio' GROUP BY winning_source ORDER BY cnt DESC
`);
console.log('peRatio by source:', r3.rows);
process.exit(0);
