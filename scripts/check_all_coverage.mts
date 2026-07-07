import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql`
  SELECT
    COUNT(*) total,
    COUNT(pe_ratio) pe_ratio,
    COUNT(peg_ratio) peg_ratio,
    COUNT(price_to_sales) price_to_sales,
    COUNT(price_to_book) price_to_book,
    COUNT(ev_to_ebitda) ev_to_ebitda,
    COUNT(gross_margin) gross_margin,
    COUNT(operating_margin) operating_margin,
    COUNT(net_margin) net_margin,
    COUNT(return_on_equity) return_on_equity,
    COUNT(return_on_assets) return_on_assets,
    COUNT(roic) roic,
    COUNT(revenue_growth_yoy) revenue_growth_yoy,
    COUNT(eps_growth) eps_growth,
    COUNT(debt_to_equity) debt_to_equity,
    COUNT(current_ratio) current_ratio,
    COUNT(quick_ratio) quick_ratio,
    COUNT(beta) beta,
    COUNT(dividend_yield) dividend_yield,
    COUNT(earnings_per_share) earnings_per_share,
    COUNT(analyst_target_price) analyst_target_price,
    COUNT(fcf_per_share) fcf_per_share,
    COUNT(fcf_margin) fcf_margin
  FROM ticker_fundamentals
`);
const row = r.rows[0] as any;
const total = Number(row.total);
const entries = Object.entries(row).filter(([k]) => k !== 'total').map(([k, v]) => [k, Number(v), Math.round(Number(v)/total*100)] as [string,number,number]);
entries.sort((a,b) => a[2]-b[2]);
console.log(`Total tickers: ${total}\n`);
for (const [k, v, pct] of entries) console.log(`${pct.toString().padStart(3)}%  ${v.toString().padStart(3)}  ${k}`);
process.exit(0);
