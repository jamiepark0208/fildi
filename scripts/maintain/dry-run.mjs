import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIR, ROOT } from "./constants.mjs";
import { printMorningChain } from "./schedule-helpers.mjs";

/** Classify research child result — shared by live path + dry-run unit check. */
function classifyResearchResult(r) {
  if (!r) return { soft: true, tag: "spawn_error" };
  if (r.signal || r.status == null) return { soft: true, tag: r.signal || "timeout" };
  if (r.status !== 0) return { soft: true, tag: `exit_${r.status}` };
  return { soft: false, tag: "exit_0" };
}

async function runDryRunSmoke() {
  printMorningChain();
  mkdirSync(LOG_DIR, { recursive: true });
  console.log("\n[maintain] dry-run desk health (no vendor APIs)…");
  const health = spawnSync(
    process.execPath,
    [join(ROOT, "scripts/health-check.mjs"), "--desk-only", "--json"],
    { encoding: "utf8", cwd: ROOT, timeout: 30_000 },
  );
  if (health.status !== 0 && !health.stdout) {
    console.error("[maintain] dry-run health-check failed to spawn", health.error || health.stderr);
    process.exit(2);
  }
  let summary;
  try {
    summary = JSON.parse(health.stdout || "{}");
  } catch (e) {
    console.error("[maintain] dry-run health JSON parse fail", e.message);
    process.exit(2);
  }
  const deskRows = (summary.results || []).filter((r) =>
    ["api_healthz", "vite", "postgres", "macro_data_cache", "macro_charts_cache"].includes(r.name),
  );
  for (const r of deskRows) {
    console.log(`  ${r.ok ? "OK" : "FAIL"}  ${r.name}  ${r.detail || ""}`);
  }

  // Unit: research soft classifier (no python spawn)
  const cases = [
    { status: 0, signal: null, expectSoft: false },
    { status: null, signal: "SIGTERM", expectSoft: true },
    { status: 1, signal: null, expectSoft: true },
  ];
  console.log("\n[maintain] dry-run research soft classifier…");
  for (const c of cases) {
    const got = classifyResearchResult(c);
    const pass = got.soft === c.expectSoft;
    console.log(`  ${pass ? "OK" : "FAIL"}  status=${c.status} signal=${c.signal} → soft=${got.soft} (${got.tag})`);
    if (!pass) process.exit(2);
  }

  const { appendAutoLedger } = await import("../auto-ledger.mjs");
  const entry = appendAutoLedger({
    id: "maintain-dry-run",
    rail: "A",
    goal: "dry-run local smoke (no vendor APIs)",
    ok: !!summary.processOk,
    value: summary.processOk ? "NO MATERIAL CHANGE" : "FAILED",
    actions: ["dry_run", "desk_only_health"],
    softFailed: summary.softFailed || [],
    evidence: {
      deskOnly: true,
      processOk: summary.processOk,
      softFailed: summary.softFailed,
      results: deskRows,
    },
    note: "maintain --dry-run",
  });
  console.log(`\n[maintain] dry-run ledger → ${entry.evidencePath || "auto-ledger.jsonl"}`);
  console.log(`[maintain] dry-run done  processOk=${summary.processOk} softFailed=${(summary.softFailed || []).join(",") || "—"}`);
  process.exit(summary.processOk ? 0 : 1);
}

export { classifyResearchResult, runDryRunSmoke };
