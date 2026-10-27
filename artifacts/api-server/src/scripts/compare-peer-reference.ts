/**
 * Before/after for the 10-27 universe add (read-only, dry-run of the production pipeline).
 * For names scored before the add (fund_score_snapshots on --base, default 2026-10-26):
 *   A = that snapshot · B = today, every member sets the peer norms · C = today, only reviewed + data-complete members do.
 * C − B isolates the reviewed-members rule; C − A is the total change an existing name sees (includes a day of new data).
 *
 *   pnpm exec tsx src/scripts/compare-peer-reference.ts [--base=2026-10-26]
 */
import { pool } from "@workspace/db";
import { computeAndPersistFundamentalScores, type FundScoreResult } from "../lib/fundamentals-db.js";
import { getLatestRegime } from "../routes/regime.js";

const base = (process.argv.find((a) => a.startsWith("--base="))?.split("=")[1]) ?? "2026-10-26";

function stats(d: number[]) {
  const s = [...d].sort((x, y) => x - y);
  const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))]!.toFixed(1);
  return { n: d.length, meanAbs: (d.reduce((a, x) => a + Math.abs(x), 0) / d.length).toFixed(2), p05: q(0.05), median: q(0.5), p95: q(0.95),
    over5: d.filter((x) => Math.abs(x) > 5).length, over10: d.filter((x) => Math.abs(x) > 10).length };
}

async function main() {
  const { rows } = await pool.query<{ ticker: string; fund_total: string | null; peer_group_id: string | null }>(
    "SELECT ticker, fund_total, peer_group_id FROM fund_score_snapshots WHERE as_of = $1::date", [base]);
  const A = new Map(rows.filter((r) => r.fund_total != null).map((r) => [r.ticker, Number(r.fund_total)]));
  const groupA = new Map(rows.map((r) => [r.ticker, r.peer_group_id]));
  const regime = await getLatestRegime();
  const B = await computeAndPersistFundamentalScores(regime, "admin_recompute", { dryRun: true, peerReference: false });
  const C = await computeAndPersistFundamentalScores(regime, "admin_recompute", { dryRun: true, peerReference: true });
  const by = (rs: FundScoreResult[]) => new Map(rs.filter((r) => r.totalScore != null).map((r) => [r.ticker, r]));
  const b = by(B), c = by(C);
  const old = [...A.keys()].filter((t) => b.has(t) && c.has(t));
  const sameGroup = old.filter((t) => groupA.get(t) === c.get(t)!.peerGroupId);
  console.log(JSON.stringify({
    base, existingScored: old.length, existingSameGroup: sameGroup.length,
    scoredToday: { allMembers: b.size, reviewedOnly: c.size },
    newNamesScored: [...c.keys()].filter((t) => !A.has(t)).length,
    "C−B reviewed-members rule (existing names)": stats(old.map((t) => c.get(t)!.totalScore! - b.get(t)!.totalScore!)),
    "B−A add with every member in the norms": stats(sameGroup.map((t) => b.get(t)!.totalScore! - A.get(t)!)),
    "C−A add with reviewed members only": stats(sameGroup.map((t) => c.get(t)!.totalScore! - A.get(t)!)),
  }, null, 2));
  const mv = sameGroup.map((t) => ({ t, a: A.get(t)!, b: b.get(t)!.totalScore!, c: c.get(t)!.totalScore!, g: c.get(t)!.peerGroupId }))
    .sort((x, y) => Math.abs(y.c - y.a) - Math.abs(x.c - x.a)).slice(0, 15);
  console.log("\nbiggest movers vs base (A → B all members / C reviewed only):");
  for (const m of mv) console.log(`  ${m.t.padEnd(6)} ${m.a.toFixed(1).padStart(5)} → ${m.b.toFixed(1).padStart(5)} / ${m.c.toFixed(1).padStart(5)}  ${m.g}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
