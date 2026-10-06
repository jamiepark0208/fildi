#!/usr/bin/env node
/**
 * Weekly Stock DB data-ops check — token-cheap, quantifies value.
 *
 * Modes:
 *   Default (agent / Run now):
 *     1) Snapshot scoreboard (before)
 *     2) Budgeted FactSet NR drain if remaining ≥ max+20 — **skipped** when Mac Maintain
 *        already drained + peer-healed in the last 7 days (avoid double FactSet spend)
 *     3) merge-trusted (always unless --digest-only)
 *     4) peer-health-check — skipped under the same Maintain-covered rule
 *     5) Snapshot after + append value log
 *   --digest-only (Sunday Maintain spine):
 *     Audit + append value log only — no merge/drain/peer. Prefer this over a second weekly ritual.
 *
 *   node scripts/weekly-data-ops-check.mjs
 *   node scripts/weekly-data-ops-check.mjs --max=40
 *   node scripts/weekly-data-ops-check.mjs --digest-only
 *   node scripts/weekly-data-ops-check.mjs --dry-run
 *   node scripts/weekly-data-ops-check.mjs --force   # ignore Maintain-covered skip
 *
 * Writes: /tmp/fildi-logs/data-ops-value/YYYY-MM-DD.json
 *         /tmp/fildi-logs/weekly-data-ops-last.json
 *         .cursor/context/data-ops-value-log.md (append)
 */
import { spawnSync, execSync } from "node:child_process";
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = "/tmp/fildi-logs";
const VALUE_DIR = join(LOG_DIR, "data-ops-value");
const VALUE_MD = join(ROOT, ".cursor/context/data-ops-value-log.md");
const AUDIT = join(ROOT, "scripts/data-ops-audit.mjs");

const maxArg = process.argv.find((a) => a.startsWith("--max="));
const maxTickers = maxArg ? Number(maxArg.split("=")[1]) : 40;
const dryRun = process.argv.includes("--dry-run");
const digestOnly = process.argv.includes("--digest-only");
const forceFull = process.argv.includes("--force");
const MAINTAIN_FULL = join(LOG_DIR, "maintain-full-last.json");
const MAINTAIN_COVER_MS = 7 * 24 * 60 * 60 * 1000;

/** True when Maintain full pass already did drain + peer-health within 7d. */
function maintainCoveredHeavyWork() {
  if (forceFull) return false;
  try {
    if (!existsSync(MAINTAIN_FULL)) return false;
    const r = JSON.parse(readFileSync(MAINTAIN_FULL, "utf8"));
    const ts = typeof r.ts === "string" ? Date.parse(r.ts) : NaN;
    if (!Number.isFinite(ts) || Date.now() - ts > MAINTAIN_COVER_MS) return false;
    const actions = Array.isArray(r.actions) ? r.actions : [];
    const drained = actions.some((a) => typeof a === "string" && /^drain_nr_\d+_.*_exit_0$/.test(a));
    const peered = actions.some((a) => typeof a === "string" && /^peer_health_exit_0$/.test(a));
    // Also accept "skipped drain for budget" + successful peer heal as covered.
    const drainSkippedOk = actions.some(
      (a) => typeof a === "string" && /^drain_nr_skipped_rem_/.test(a),
    );
    return peered && (drained || drainSkippedOk);
  } catch {
    return false;
  }
}

function loadEnvLocal() {
  const path = join(ROOT, ".env.local");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    let [k, ...rest] = line.split("=");
    k = k.trim();
    let v = rest.join("=").trim().replace(/^["']|["']$/g, "");
    if (process.env[k] === undefined) process.env[k] = v;
  }
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = "postgresql://jamiepark@127.0.0.1:5432/tradedash";
  }
}

function runAudit() {
  const r = spawnSync(process.execPath, [AUDIT, "--json-only"], {
    encoding: "utf8",
    cwd: ROOT,
    env: process.env,
  });
  try {
    return JSON.parse(readFileSync(`${LOG_DIR}/data-ops-audit-last.json`, "utf8"));
  } catch {
    return { ok: false, parseError: true, stderr: (r.stderr || "").slice(0, 300) };
  }
}

function runTsx(scriptRel, args = []) {
  const cmd = [
    "bash",
    "-lc",
    `
      set -a
      [ -f "${ROOT}/.env.local" ] && . "${ROOT}/.env.local"
      set +a
      export PATH="$HOME/Applications/Postgres.app/Contents/Versions/16/bin:/usr/local/bin:$PATH"
      export DATABASE_URL="\${DATABASE_URL:-postgresql://jamiepark@127.0.0.1:5432/tradedash}"
      cd "${ROOT}/artifacts/api-server" && pnpm exec tsx ${scriptRel} ${args.join(" ")}
    `,
  ];
  const r = spawnSync(cmd[0], cmd.slice(1), {
    encoding: "utf8",
    cwd: ROOT,
    timeout: 20 * 60 * 1000,
  });
  return {
    status: r.status,
    stdoutTail: (r.stdout || "").slice(-1200),
    stderrTail: (r.stderr || "").slice(-400),
  };
}

function delta(before, after, path) {
  const b = path.split(".").reduce((o, k) => o?.[k], before);
  const a = path.split(".").reduce((o, k) => o?.[k], after);
  if (typeof b === "number" && typeof a === "number") return a - b;
  return null;
}

function filledLine(sb, key) {
  const u = sb?.universe ?? "?";
  const v = sb?.filled?.[key];
  return v == null ? null : `${v}/${u}`;
}

loadEnvLocal();
mkdirSync(VALUE_DIR, { recursive: true });

const started = Date.now();
const before = runAudit();
const beforeSb = before.scoreboard || {};
const rem = beforeSb.factset?.remaining ?? 0;
const coveredByMaintain = maintainCoveredHeavyWork();

const actions = [];
let drain = null;
let merge = null;
let peers = null;

if (digestOnly) {
  actions.push("digest_only");
  if (coveredByMaintain) actions.push("maintain_covered_7d");
} else if (dryRun) {
  actions.push("dry_run");
  peers = runTsx("src/scripts/peer-health-check.ts", ["--dry-run"]);
  actions.push(`peer_health_dry_exit_${peers.status}`);
} else if (coveredByMaintain) {
  // Maintain already drained + peer-healed this week — only merge + measure.
  actions.push("maintain_covered_skip_drain_peer");
  merge = runTsx("src/scripts/merge-trusted.ts");
  actions.push(`merge_exit_${merge.status}`);
} else {
  // Always merge — applies derives + provenance honesty (0 API).
  merge = runTsx("src/scripts/merge-trusted.ts");
  actions.push(`merge_exit_${merge.status}`);

  if (rem >= maxTickers + 20) {
    drain = runTsx("src/scripts/drain-needs-review.ts", [`--max=${maxTickers}`]);
    actions.push(`drain_max_${maxTickers}_exit_${drain.status}`);
  } else {
    actions.push(`drain_skipped_factset_rem_${rem}`);
  }

  peers = runTsx("src/scripts/peer-health-check.ts");
  actions.push(`peer_health_exit_${peers.status}`);
}

function loadPeerReport() {
  try {
    return JSON.parse(readFileSync(`${LOG_DIR}/peer-health-last.json`, "utf8"));
  } catch {
    return null;
  }
}

const after = runAudit();
const afterSb = after.scoreboard || {};
const peerReport = loadPeerReport();

const benefit = {
  nrDelta: delta(beforeSb, afterSb, "nr"),
  stalePegProvDelta: delta(beforeSb, afterSb, "staleYahooPegProv"),
  techMissingDelta: delta(beforeSb, afterSb, "techMissing"),
  peFilledDelta: delta(beforeSb, afterSb, "filled.peRatio"),
  pegFilledDelta: delta(beforeSb, afterSb, "filled.pegRatio"),
  omFilledDelta: delta(beforeSb, afterSb, "filled.operatingMargin"),
  factsetSpent: (beforeSb.factset?.remaining ?? 0) - (afterSb.factset?.remaining ?? 0),
  peerNewlyMapped: peerReport?.healed?.newlyMapped?.length ?? 0,
  peerRosterHealed: peerReport?.healed?.rosterGaps ?? 0,
  peerEtfQuarantined: peerReport?.healed?.etfQuarantined?.length ?? 0,
  peerFfUnmapped: peerReport?.remaining?.ffUnmapped?.length ?? null,
  peerKeywordMismatches: peerReport?.flags?.keywordMismatch?.length ?? null,
};

const improved =
  (benefit.nrDelta != null && benefit.nrDelta < 0) ||
  (benefit.stalePegProvDelta != null && benefit.stalePegProvDelta < 0) ||
  (benefit.peFilledDelta != null && benefit.peFilledDelta > 0) ||
  (benefit.omFilledDelta != null && benefit.omFilledDelta > 0) ||
  (benefit.techMissingDelta != null && benefit.techMissingDelta < 0) ||
  benefit.peerNewlyMapped > 0 ||
  benefit.peerRosterHealed > 0 ||
  benefit.peerEtfQuarantined > 0;

const summaryLines = [
  benefit.nrDelta != null ? `Needs Review ${beforeSb.nr} → ${afterSb.nr} (Δ ${benefit.nrDelta})` : null,
  benefit.stalePegProvDelta != null
    ? `Stale PEG provenance ${beforeSb.staleYahooPegProv} → ${afterSb.staleYahooPegProv} (Δ ${benefit.stalePegProvDelta})`
    : null,
  `P/E filled ${filledLine(beforeSb, "peRatio")} → ${filledLine(afterSb, "peRatio")}`,
  `PEG filled ${filledLine(beforeSb, "pegRatio")} → ${filledLine(afterSb, "pegRatio")}`,
  `OpMargin filled ${filledLine(beforeSb, "operatingMargin")} → ${filledLine(afterSb, "operatingMargin")}`,
  `FactSet spent this run: ${benefit.factsetSpent}`,
  `Tech missing ${beforeSb.techMissing} → ${afterSb.techMissing}`,
  peerReport
    ? `Peers: mapped ${peerReport.counts?.ffMapped}/${peerReport.counts?.ff}` +
      ` · healed roster ${benefit.peerRosterHealed}` +
      ` · newly classified ${benefit.peerNewlyMapped}` +
      ` · ETF quarantined ${benefit.peerEtfQuarantined}` +
      ` · still unmapped ${benefit.peerFfUnmapped}` +
      ` · keyword mismatches ${benefit.peerKeywordMismatches}`
    : "Peers: (peer-health report missing)",
].filter(Boolean);

const report = {
  ts: new Date().toISOString(),
  ms: Date.now() - started,
  dryRun,
  digestOnly,
  coveredByMaintain,
  maxTickers,
  actions,
  improved,
  benefit,
  before: beforeSb,
  after: afterSb,
  peers: peerReport,
  summary: summaryLines,
  auditOk: !!after.ok,
  plan: ".agents/context/stock-db-best-realistic.md",
};

const day = report.ts.slice(0, 10);
writeFileSync(join(VALUE_DIR, `${day}.json`), JSON.stringify(report, null, 2));
writeFileSync(join(LOG_DIR, "weekly-data-ops-last.json"), JSON.stringify(report, null, 2));

const modeTag = digestOnly ? " (digest-only)" : dryRun ? " (dry-run)" : coveredByMaintain ? " (Maintain-covered)" : "";
const mdBlock = `
## ${report.ts}${modeTag}
**Value:** ${improved ? "IMPROVED" : "NO MATERIAL CHANGE"} · ${report.ms}ms
${summaryLines.map((l) => `- ${l}`).join("\n")}
- Actions: ${actions.join(", ")}
`;

if (!existsSync(VALUE_MD)) {
  writeFileSync(
    VALUE_MD,
    `# Data-ops value log\n\nAppend-only proof from \`weekly-data-ops-check.mjs\` (Sunday Maintain \`--digest-only\` or agent).\n`,
  );
}
appendFileSync(VALUE_MD, mdBlock);

console.log(`[weekly-data-ops] ${report.ts}`);
console.log(`  ${improved ? "IMPROVED" : "NO MATERIAL CHANGE"}`);
for (const l of summaryLines) console.log(`  ${l}`);
console.log(`  actions: ${actions.join(", ")}`);
console.log(`  log: ${VALUE_MD}`);
console.log(`  json: ${join(VALUE_DIR, `${day}.json`)}`);

process.exit(after.ok || dryRun ? 0 : 1);
