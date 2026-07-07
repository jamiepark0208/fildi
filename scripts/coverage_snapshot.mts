import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  SELECT COUNT(*) total,
    COUNT(pe_ratio) pe_ratio, COUNT(price_to_sales) price_to_sales,
    COUNT(price_to_book) price_to_book, COUNT(gross_margin) gross_margin,
    COUNT(operating_margin) operating_margin, COUNT(net_margin) net_margin,
    COUNT(return_on_equity) return_on_equity, COUNT(return_on_assets) return_on_assets,
    COUNT(roic) roic, COUNT(revenue_growth_yoy) revenue_growth_yoy,
    COUNT(eps_growth) eps_growth, COUNT(current_ratio) current_ratio,
    COUNT(beta) beta, COUNT(dividend_yield) dividend_yield,
    COUNT(earnings_per_share) earnings_per_share
  FROM ticker_fundamentals
`);
const row = r.rows[0] as any;
const total = Number(row.total);
console.log(`BEFORE (total=${total}):`);
for (const [k, v] of Object.entries(row).filter(([k]) => k !== 'total'))
  console.log(`  ${k}: ${v}/${total} (${Math.round(Number(v)/total*100)}%)`);
process.exit(0);
