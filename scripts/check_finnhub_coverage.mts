import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`SELECT COUNT(*) total, COUNT(finnhub_pe_ratio) pe_filled, COUNT(finnhub_beta) beta_filled FROM finnhub_fundamentals`);
console.log('finnhub_fundamentals:', JSON.stringify(r.rows[0]));
const r2 = await db.execute(sql`SELECT COUNT(*) total, COUNT(pe_ratio) pe_filled, COUNT(dividend_yield) div_filled FROM ticker_fundamentals`);
console.log('ticker_fundamentals:', JSON.stringify(r2.rows[0]));
const r3 = await db.execute(sql`SELECT ticker, finnhub_pe_ratio FROM finnhub_fundamentals WHERE finnhub_pe_ratio IS NULL LIMIT 10`);
console.log('tickers with null PE in finnhub:', r3.rows.map((x:any) => x.ticker).join(', '));
process.exit(0);
