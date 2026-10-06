#!/usr/bin/env node
/**
 * Ops brief — narrate existing proof JSON only (Phase 5).
 * Usage: node .cursor/scripts/ops-brief.mjs
 * Exit 0 always unless a read throws unexpectedly.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LOG = "/tmp/fildi-logs";

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { _error: `unreadable:${path}` };
  }
}

function lastValueLogLine() {
  const p = join(ROOT, ".cursor/context/data-ops-value-log.md");
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
  // Prefer a verdict line if present
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/IMPROVED|NO MATERIAL CHANGE|NEEDS_YOU|FAILED/i.test(lines[i])) return lines[i].trim();
  }
  return lines[lines.length - 1] ?? null;
}

function latestAiVerify() {
  const dir = join(ROOT, ".cursor/context/ai-workflow-reviews");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith("-verify.json") || f.endsWith(".json"))
    .sort();
  if (!files.length) return null;
  const prefer = [...files].reverse().find((f) => f.includes("verify")) ?? files[files.length - 1];
  return { name: prefer, data: readJson(join(dir, prefer)) };
}

function bucketFromRemediate(r) {
  if (!r || r._error) return null;
  const v = String(r.value ?? "");
  if (v === "IMPROVED") return "AUTO_FIXED";
  if (v === "NO MATERIAL CHANGE" || v === "STARTED") return "NO_MATERIAL_CHANGE";
  if (v === "NEEDS_YOU" || v === "FAILED") return "NEEDS_YOU";
  return "NO_MATERIAL_CHANGE";
}

function maintainBuckets(m) {
  const auto = [];
  const needs = [];
  const none = [];
  if (!m || m._error) return { auto, needs, none };
  const actions = Array.isArray(m.actions) ? m.actions.map(String) : [];
  if (actions.some((a) => a === "process_healed")) auto.push("stack process_healed");
  if (m.processOk === false || actions.some((a) => /process_still_down/.test(a))) {
    needs.push("stack still down — Run Remediate / Maintain");
  }
  for (const a of actions) {
    if (/_exit_[1-9]/.test(a)) needs.push(`action fail: ${a}`);
    else if (/_exit_0$/.test(a) && /enrich|peer|retention|morning|ops_digest|ai_workflow/.test(a)) {
      none.push(a);
    }
  }
  if (m.ok === true && auto.length === 0 && needs.length === 0) {
    none.push("maintain ok (no material heal)");
  }
  return { auto, needs, none };
}

const remediate = readJson(join(LOG, "ops-remediate-last.json"));
const maintain = readJson(join(LOG, "maintain-last.json"));
const maintainFull = readJson(join(LOG, "maintain-full-last.json"));
const valueLine = lastValueLogLine();
const ai = latestAiVerify();

const autoFixed = [];
const noChange = [];
const needsYou = [];

const remBucket = bucketFromRemediate(remediate);
if (remediate && !remediate._error) {
  const line = [
    `remediate ${remediate.value}`,
    remediate.trigger,
    Array.isArray(remediate.taskIds) ? remediate.taskIds.join(",") : "",
    remediate.alertsBefore >= 0 && remediate.alertsAfter != null
      ? `alerts ${remediate.alertsBefore}→${remediate.alertsAfter}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (remBucket === "AUTO_FIXED") autoFixed.push(line);
  else if (remBucket === "NEEDS_YOU") needsYou.push(line);
  else noChange.push(line);
} else {
  noChange.push("remediate: missing");
}

const mb = maintainBuckets(maintain ?? maintainFull);
autoFixed.push(...mb.auto);
needsYou.push(...mb.needs);
noChange.push(...mb.none.slice(0, 4));

if (valueLine) {
  if (/IMPROVED/i.test(valueLine) && !/NO MATERIAL/i.test(valueLine)) autoFixed.push(`value-log: ${valueLine.slice(0, 120)}`);
  else if (/NO MATERIAL CHANGE/i.test(valueLine)) noChange.push(`value-log: ${valueLine.slice(0, 120)}`);
  else noChange.push(`value-log: ${valueLine.slice(0, 120)}`);
} else {
  noChange.push("value-log: missing");
}

if (ai?.data) {
  const ok = ai.data.ok !== false && ai.data.regression !== true;
  let detail;
  if (typeof ai.data.proofLine === "string") detail = ai.data.proofLine;
  else if (typeof ai.data.summary === "string") detail = ai.data.summary;
  else if (typeof ai.data.hotContextEstTokens === "number") {
    detail = `hotContext=${ai.data.hotContextEstTokens}`;
  } else if (ai.data.hotContextEstTokens && typeof ai.data.hotContextEstTokens === "object") {
    const h = ai.data.hotContextEstTokens;
    detail = `hotContext≈${h.after ?? h.total ?? h.est ?? "?"}`;
  } else {
    detail = ai.name;
  }
  if (ok) noChange.push(`ai-workflow: ${String(detail).slice(0, 100)}`);
  else needsYou.push(`ai-workflow verify fail: ${String(detail).slice(0, 100)}`);
} else {
  noChange.push("ai-workflow: missing");
}

function section(title, rows) {
  console.log(`## ${title}`);
  if (!rows.length) {
    console.log("(none)");
    return;
  }
  for (const r of rows) console.log(`- ${r}`);
}

console.log("# Ops brief");
console.log(`at: ${new Date().toISOString()}`);
console.log("");
section("AUTO_FIXED", autoFixed);
console.log("");
section("NO_MATERIAL_CHANGE", noChange);
console.log("");
section("NEEDS_YOU", needsYou);
console.log("");
console.log("Sources: ops-remediate-last.json · maintain-last.json · data-ops-value-log.md · ai-workflow-reviews/");
