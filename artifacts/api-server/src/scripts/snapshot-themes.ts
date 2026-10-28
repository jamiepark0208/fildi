#!/usr/bin/env npx tsx
/**
 * Key Themes daily snapshot (learning loop, Jamie 10-28) — run by daily.py (publish stage, soft).
 * One row per theme per day in watchlist_sync.theme_snapshots (+ theme_id '_read' for the unified read), so each
 * view can be graded on its check date against what its signposts said at the time (LOG.md outcome column).
 *   cd artifacts/api-server && npx tsx src/scripts/snapshot-themes.ts [--print]
 */
import { pool } from "@workspace/db";
import { buildThemes, loadCapPanel } from "../lib/macro/macro-themes.js";

async function main() {
  const t = await buildThemes(await loadCapPanel());
  if (!t) throw new Error("themes.json missing");
  if (process.argv.includes("--print")) {
    for (const th of t.themes) {
      console.log(`${th.name} [${th.horizon}] view=${th.view.stance} lean=${th.lean} ${th.bull}↑ ${th.bear}↓ ${th.neutral}= ${th.missing}?${th.divergence ? "  ⚠ view ≠ signposts" : ""}`);
      for (const s of th.signposts) console.log(`   ${s.status.padEnd(7)} ${s.label}: ${s.current == null ? "—" : s.current.toFixed(2)} ${s.unit ?? ""} (${s.asOf ?? "?"}) ${s.detail ?? ""}`);
    }
    console.log(`READ ${t.read.label} ${t.read.score?.toFixed(2)} | ${t.read.parts.map((p) => `${p.label}: ${p.readout} (${p.score?.toFixed(2) ?? "—"})`).join(" · ")}`);
    console.log("as of", JSON.stringify(t.asOf));
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS watchlist_sync.theme_snapshots (
    snap_date date NOT NULL, theme_id text NOT NULL, view_stance text, view_p numeric, lean text, score numeric,
    divergence boolean, signposts jsonb NOT NULL DEFAULT '[]', created_at timestamptz DEFAULT now(),
    PRIMARY KEY (snap_date, theme_id))`);
  const rows: unknown[][] = t.themes.map((th) => [th.id, th.view.stance, th.view.p, th.lean, th.score, th.divergence,
    JSON.stringify(th.signposts.map((s) => ({ id: s.id, v: s.current, status: s.status, asOf: s.asOf })))]);
  rows.push(["_read", null, t.read.pUp12m, t.read.label, t.read.score, false,
    JSON.stringify({ parts: t.read.parts.map((p) => ({ key: p.key, score: p.score, readout: p.readout })), scenarios: t.scenarios.map((s) => ({ id: s.id, p: s.p, pointing: s.pointing })) })]);
  for (const r of rows) {
    await pool.query(`INSERT INTO watchlist_sync.theme_snapshots (snap_date, theme_id, view_stance, view_p, lean, score, divergence, signposts)
      VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (snap_date, theme_id) DO UPDATE SET view_stance = EXCLUDED.view_stance, view_p = EXCLUDED.view_p,
        lean = EXCLUDED.lean, score = EXCLUDED.score, divergence = EXCLUDED.divergence, signposts = EXCLUDED.signposts`, r);
  }
  const div = t.themes.filter((th) => th.divergence).map((th) => th.id);
  const due = t.themes.filter((th) => th.checkDue).map((th) => th.id);
  const stale = t.themes.flatMap((th) => th.signposts).filter((s) => s.status === "stale" || s.status === "missing").map((s) => s.id);
  console.log(`themes snapshot: ${t.themes.length} themes, read ${t.read.label}; diverging ${div.join(",") || "none"}; ` +
    `check due ${due.join(",") || "none"}; stale/missing ${stale.join(",") || "none"}; registry ${t.registryAgeDays} d old`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
