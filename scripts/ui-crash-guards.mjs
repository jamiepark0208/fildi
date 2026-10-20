#!/usr/bin/env node
/**
 * Cheap static guards for UI crashes we already shipped once (Jamie 2026-10-20).
 * No browser. Exit 1 = fail. Not a hard ship gate (string checks are brittle) —
 * run by hand or as advisory when INDEX / Agents / Research / feed reset paths change.
 *
 * Checks:
 *  1. research/studies/INDEX.md — every | S### | catalog row has a Status after pipe-join parse
 *  2. AgentsTab Stage map — onPick only focuses ids in META (Jobs/OpenJev must not set focus)
 *  3. ResearchTab — tone() null-safe
 *  4. reset-stats — sets cashBalance to 0
 *  5. ticker-pnl — drops ~$0 rows
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const fail = (msg) => { console.error(`ui-crash-guards: FAIL ${msg}`); fails++; };
const ok = (msg) => console.log(`ui-crash-guards: ok ${msg}`);

/** Same join logic as GET /api/research/studies (extra `|` inside Answer). */
function parseStudies(md) {
  const rows = [];
  for (const line of md.split("\n")) {
    if (!/^\| (S\d{3}) \|/.test(line)) continue;
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    if (c.length >= 6) {
      rows.push({
        id: c[0],
        status: c[c.length - 2] || "",
        report: c[c.length - 1] ?? "",
        cols: c.length,
      });
    } else {
      rows.push({ id: c[0] ?? "?", status: "", report: "", cols: c.length });
    }
  }
  return rows;
}

// 1) INDEX catalog
{
  const md = readFileSync(join(ROOT, "research/studies/INDEX.md"), "utf8");
  const rows = parseStudies(md);
  if (rows.length < 10) fail(`INDEX parse too few rows (${rows.length})`);
  const missing = rows.filter((r) => !r.status);
  if (missing.length) {
    fail(`INDEX missing Status for: ${missing.map((r) => `${r.id}(cols=${r.cols})`).join(", ")}`);
  } else {
    ok(`INDEX ${rows.length} catalog rows have Status`);
  }
}

// 2–5) source string guards
{
  const agents = readFileSync(join(ROOT, "artifacts/stock-compare/src/components/settings/AgentsTab.tsx"), "utf8");
  if (!/if \(id in META\) onSel\(id as Id\)/.test(agents)) {
    fail("AgentsTab onPick must only focus ids in META");
  } else ok("AgentsTab onPick META guard");

  const research = readFileSync(join(ROOT, "artifacts/stock-compare/src/components/settings/ResearchTab.tsx"), "utf8");
  if (!/function tone\(status: string \| null \| undefined\)/.test(research)
    || !/\(status \?\? ""\)\.toLowerCase\(\)/.test(research)) {
    fail("ResearchTab tone() must accept null/undefined status");
  } else ok("ResearchTab tone null-safe");

  const feed = readFileSync(join(ROOT, "artifacts/api-server/src/routes/feed.ts"), "utf8");
  const resetStart = feed.indexOf("router.post('/feed/portfolio/reset-stats'");
  const resetBlock = resetStart >= 0 ? feed.slice(resetStart, resetStart + 4500) : "";
  if (!/cashBalance:\s*'0'/.test(resetBlock)) {
    fail("reset-stats must set users.cashBalance to '0'");
  } else ok("reset-stats zeros cash");

  const pnl = readFileSync(join(ROOT, "artifacts/api-server/src/lib/ticker-pnl.ts"), "utf8");
  if (!/\.filter\(\(r\) => Math\.abs\(r\.totalPnl\) >= 0\.005\)/.test(pnl)) {
    fail("ticker-pnl must drop near-zero totalPnl rows");
  } else ok("ticker-pnl zero-filter");
}

if (fails) {
  console.error(`ui-crash-guards: ${fails} failure(s)`);
  process.exit(1);
}
console.log("ui-crash-guards: all ok");
