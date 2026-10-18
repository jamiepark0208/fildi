/**
 * A160 — peer taxonomy merges + fund before/after (AGENTS rule 7).
 * Dry-run: score under current taxonomy. --apply: run seed:peers then recompute.
 * Usage: cd artifacts/api-server && pnpm exec tsx src/scripts/a160-peer-merges.ts [--apply]
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { computeAndPersistFundamentalScores, type FundScoreResult } from "../lib/fundamentals-db.js";
import { getLatestRegime } from "../routes/regime.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const MOVED = new Set([
  "WM", "RSG", "WCN", "CLH", "ECOL",
  "JPM", "BAC", "C", "WFC", "GS", "MS", "USB", "PNC", "SCHW", "TFC", "BK", "STT",
  "RF", "FITB", "KEY", "CFG", "HBAN", "MTB", "ZION", "CMA", "FHN", "EWBC", "WAL",
]);

const apply = process.argv.includes("--apply");
const byTicker = (rs: FundScoreResult[]) => new Map(rs.map((r) => [r.ticker, r]));
const f = (v: number | null | undefined) => (v == null ? "n/a" : v.toFixed(1));

async function main() {
  const regime = await getLatestRegime();
  const before = byTicker(await computeAndPersistFundamentalScores(regime, "admin_recompute", { dryRun: true }));

  if (apply) {
    const root = join(import.meta.dirname, "../../../../");
    console.log("running seed:peers…");
    execSync("pnpm --filter @workspace/scripts seed:peers", { cwd: root, stdio: "inherit" });
  }

  const after = byTicker(await computeAndPersistFundamentalScores(regime, "admin_recompute", { dryRun: !apply }));

  const list = [...MOVED].sort();
  const reg = await db.execute(sql`
    SELECT ticker, primary_peer_group_id AS g FROM ticker_registry
    WHERE ticker IN (${sql.join(list.map((t) => sql`${t}`), sql`, `)}) ORDER BY ticker`);
  const regRows = ((reg as unknown as { rows?: { ticker: string; g: string }[] }).rows
    ?? (reg as unknown as { ticker: string; g: string }[])) as { ticker: string; g: string }[];
  console.log("registry:", Object.fromEntries(regRows.map((r) => [r.ticker, r.g])));

  const rows: string[] = [];
  let changedOthers = 0;
  for (const [t, a] of after) {
    const b = before.get(t);
    const d = (a.totalScore ?? NaN) - (b?.totalScore ?? NaN);
    if (MOVED.has(t)) {
      rows.push(
        `${t}\t${f(b?.totalScore)} → ${f(a.totalScore)}\t` +
          `${b?.peerGroupId ?? "?"} → ${a.peerGroupId ?? "?"}\t` +
          `V ${f(b?.valueScore)}→${f(a.valueScore)} Q ${f(b?.qualityScore)}→${f(a.qualityScore)}`,
      );
    } else if (Number.isFinite(d) && Math.abs(d) >= 0.05) {
      changedOthers++;
    }
  }
  console.log(`${apply ? "APPLIED" : "DRY RUN"} · moved ${MOVED.size}\n` + rows.sort().join("\n"));
  console.log(`other tickers whose total moved ≥ 0.05: ${changedOthers}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
