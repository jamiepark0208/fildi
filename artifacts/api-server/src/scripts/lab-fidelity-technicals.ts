/**
 * Scorecard lab fidelity check: does the history replay reproduce the live ticker_technicals row?
 * For each ticker: same window as live (every prices_historical bar up to its last date), bars taken from
 * lseg_research.daily_history (what the replay uses) → computeFromOHLCV → compare with ticker_technicals.
 * Any mismatch is a data difference (LSEG vs prices_historical), since the function is the live one.
 *
 *   pnpm exec tsx src/scripts/lab-fidelity-technicals.ts [--n=40]
 */
import { pool } from "@workspace/db";
import { computeFromOHLCV } from "../lib/technicals-db.js";

const SRC = process.argv.find((a) => a.startsWith("--source="))?.split("=")[1] ?? "lseg";
const N = Number(process.argv.find((a) => a.startsWith("--n="))?.split("=")[1] ?? "40");
const FIELDS = ["rsi14", "rsi14Pct", "mfi14Pct", "stochPct", "rsiVelocity", "volumeRatioPct", "realizedVol20d", "bbWidthPct",
  "priceVsMa50Atr", "priceVsMa200Atr", "priceVsVwapPct", "nearestSupportDistPct"] as const;
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()).replace(/(\d+)/g, "$1");

async function main() {
  const live = (await pool.query(`SELECT t.*, (SELECT max(date)::text FROM prices_historical p WHERE p.ticker = t.ticker) last_d,
      (SELECT count(*) FROM prices_historical p WHERE p.ticker = t.ticker) nbars
    FROM ticker_technicals t WHERE ticker IN (SELECT DISTINCT ticker FROM lseg_research.daily_history WHERE high IS NOT NULL)
    ORDER BY md5(ticker) LIMIT $1`, [N])).rows;
  const stats: Record<string, { n: number; exact: number; maxAbs: number }> = {};
  let regimeOk = 0, macdOk = 0, fkOk = 0, used = 0;
  const worst: string[] = [];
  for (const r of live) {
    const table = SRC === "ph" ? "prices_historical" : "lseg_research.daily_history";
    const bars = (await pool.query(`SELECT close::float8 c, high::float8 h, low::float8 l, volume::float8 v FROM ${table}
      WHERE ticker = $1 AND date <= $2 AND high IS NOT NULL ORDER BY date DESC LIMIT $3`, [r.ticker, r.last_d, Number(r.nbars)])).rows.reverse();
    if (bars.length < Number(r.nbars) * 0.95) continue;
    used++;
    const o: any = computeFromOHLCV(bars.map((b) => b.c), bars.map((b) => b.h), bars.map((b) => b.l), bars.map((b) => b.v));
    for (const f of FIELDS) {
      const lv = r[snake(f)];
      if (lv == null || o[f] == null) continue;
      const d = Math.abs(Number(lv) - Number(o[f]));
      const s = (stats[f] ??= { n: 0, exact: 0, maxAbs: 0 });
      s.n++;
      if (d <= 0.011 * Math.max(1, Math.abs(Number(lv)))) s.exact++;
      else if (worst.length < 12) worst.push(`${r.ticker} ${f}: live ${lv} vs replay ${o[f]}`);
      s.maxAbs = Math.max(s.maxAbs, d);
    }
    if (r.regime === o.regime) regimeOk++;
    if (r.macd_direction === o.macdDirection) macdOk++;
    if (Number(r.falling_knife ?? 0) === Number(o.fallingKnife ?? 0)) fkOk++;
  }
  console.log(`fidelity: ${used} tickers (same window as live, ${SRC} bars)`);
  for (const [f, s] of Object.entries(stats)) console.log(`  ${f.padEnd(22)} match ${s.exact}/${s.n}  max |Δ| ${s.maxAbs.toFixed(3)}`);
  console.log(`  regime ${regimeOk}/${used} · macdDirection ${macdOk}/${used} · fallingKnife ${fkOk}/${used}`);
  if (worst.length) console.log("  mismatches:\n   " + worst.join("\n   "));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
