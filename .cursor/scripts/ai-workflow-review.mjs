#!/usr/bin/env node
/**
 * Weekly Cursor / AI workflow review — measures context bloat and proves whether
 * cleanup helped. Supervised: you run it, act on the report, re-run --verify.
 *
 * Metrics (quantified):
 *   - hotContextBytes / estTokens (~chars/4) for always-loaded Cursor files
 *   - skillBytes for .cursor + .claude skills
 *   - transcriptBytes / count (agent-transcripts)
 *   - oversizedMd: markdown > threshold under .cursor/.agents/.claude
 *
 * Usage:
 *   node .cursor/scripts/ai-workflow-review.mjs              # snapshot + report
 *   node .cursor/scripts/ai-workflow-review.mjs --verify     # compare to last baseline
 *   node .cursor/scripts/ai-workflow-review.mjs --json       # machine-readable only
 *
 * Exit: 0 always on snapshot; --verify exits 1 if regressions (estTokens grew >5%
 * without an explicit --allow-growth flag).
 */
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const OUT_DIR = join(ROOT, ".cursor/context/ai-workflow-reviews");
const BASELINE = join(OUT_DIR, "baseline.json");
const OVERSIZE_LINES = 400;
const HOT_CONTEXT = [
  ".cursor/context/session.md",
  ".cursor/context/cursor-state.md",
  "AGENTS.md",
  "CURSOR.md",
  ".agents/context/INDEX.md",
  ".agents/context/agentic-floors.md",
];

const args = new Set(process.argv.slice(2));
const doVerify = args.has("--verify");
const jsonOnly = args.has("--json");
const allowGrowth = args.has("--allow-growth");

function walkFiles(dir, pred, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === "node_modules" || name.name === ".git" || name.name === "dist") continue;
    const p = join(dir, name.name);
    if (name.isDirectory()) walkFiles(p, pred, acc);
    else if (pred(p, name.name)) acc.push(p);
  }
  return acc;
}

function fileMeta(abs) {
  try {
    const st = statSync(abs);
    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n").length;
    const bytes = Buffer.byteLength(text, "utf8");
    return {
      path: relative(ROOT, abs).replaceAll("\\", "/"),
      bytes,
      lines,
      estTokens: Math.ceil(bytes / 4),
      mtime: st.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function sumField(rows, key) {
  return rows.reduce((s, r) => s + (r?.[key] ?? 0), 0);
}

function collect() {
  const hot = HOT_CONTEXT.map((rel) => fileMeta(join(ROOT, rel))).filter(Boolean);

  const skillFiles = [
    ...walkFiles(join(ROOT, ".cursor"), (p, n) => n === "SKILL.md" || (n.endsWith(".mdc") && p.includes("/rules/"))),
    ...walkFiles(join(ROOT, ".claude/skills"), (p, n) => n.endsWith(".md")),
    ...walkFiles(join(ROOT, ".agents/skills"), (p, n) => n === "SKILL.md" || n.endsWith(".md")),
  ].map(fileMeta).filter(Boolean);

  const transcriptRoot = join(
    process.env.HOME ?? "",
    ".cursor/projects/Users-jamiepark-Cursor-fildi/agent-transcripts",
  );
  const transcripts = walkFiles(transcriptRoot, (p, n) => n.endsWith(".jsonl"))
    .map(fileMeta)
    .filter(Boolean)
    .sort((a, b) => b.bytes - a.bytes);

  const oversizedMd = walkFiles(
    ROOT,
    (p, n) =>
      n.endsWith(".md") &&
      (p.includes(`${ROOT}/.cursor`) || p.includes(`${ROOT}/.agents`) || p.includes(`${ROOT}/.claude`)),
  )
    .map(fileMeta)
    .filter((m) => m && m.lines > OVERSIZE_LINES)
    .sort((a, b) => b.lines - a.lines);

  const topTranscripts = transcripts.slice(0, 8);
  const topSkills = [...skillFiles].sort((a, b) => b.bytes - a.bytes).slice(0, 10);

  const metrics = {
    hotContextBytes: sumField(hot, "bytes"),
    hotContextEstTokens: sumField(hot, "estTokens"),
    skillBytes: sumField(skillFiles, "bytes"),
    skillEstTokens: sumField(skillFiles, "estTokens"),
    skillCount: skillFiles.length,
    transcriptBytes: sumField(transcripts, "bytes"),
    transcriptEstTokens: sumField(transcripts, "estTokens"),
    transcriptCount: transcripts.length,
    oversizedMdCount: oversizedMd.length,
    oversizedMdLines: sumField(oversizedMd, "lines"),
  };

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ hot, skills: skillFiles.map((s) => s.path), metrics }))
    .digest("hex")
    .slice(0, 12);

  return {
    ts: new Date().toISOString(),
    fingerprint,
    metrics,
    hot,
    topSkills,
    topTranscripts,
    oversizedMd: oversizedMd.slice(0, 15),
    checklist: [
      "Trim hot context (session.md / cursor-state.md) to facts only — drop narrated history",
      "Archive or split oversized MD (>400 lines) under .cursor/.agents/.claude",
      "Delete/merge unused skills; keep one skill load at a time in agent prompts",
      "Add a hook or rule only if it prevents a repeated mistake (≥2 times this week)",
      "Prefer codegraph over broad Read/Explore for symbol lookup (token win)",
      "Re-run: node .cursor/scripts/ai-workflow-review.mjs --verify",
    ],
  };
}

function pct(n) {
  if (!Number.isFinite(n)) return "n/a";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(1)}%`;
}

function delta(cur, prev) {
  if (prev == null || prev === 0) return { abs: cur, rel: null };
  return { abs: cur - prev, rel: (cur - prev) / prev };
}

function renderMarkdown(snap, prev) {
  const m = snap.metrics;
  const lines = [
    `# AI workflow review — ${snap.ts.slice(0, 10)}`,
    "",
    `Fingerprint: \`${snap.fingerprint}\``,
    "",
    "## Quantified metrics",
    "",
    "| Metric | Now | Δ vs baseline |",
    "|---|---:|---:|",
  ];
  const rows = [
    ["hotContextEstTokens", m.hotContextEstTokens],
    ["hotContextBytes", m.hotContextBytes],
    ["skillEstTokens", m.skillEstTokens],
    ["skillCount", m.skillCount],
    ["transcriptEstTokens", m.transcriptEstTokens],
    ["transcriptCount", m.transcriptCount],
    ["oversizedMdCount", m.oversizedMdCount],
    ["oversizedMdLines", m.oversizedMdLines],
  ];
  for (const [key, val] of rows) {
    const d = prev ? delta(val, prev.metrics?.[key]) : null;
    const dStr = d
      ? `${d.abs >= 0 ? "+" : ""}${d.abs} (${pct(d.rel)})`
      : "— (baseline)";
    lines.push(`| ${key} | ${val} | ${dStr} |`);
  }
  lines.push(
    "",
    "Token estimate uses bytes/4 (rough UTF-8 proxy). Lower hotContext + skill tokens = cheaper every prompt.",
    "",
    "## Hot context files",
    "",
  );
  for (const f of snap.hot) {
    lines.push(`- \`${f.path}\` — ${f.lines}L · ~${f.estTokens} tok`);
  }
  lines.push("", "## Largest skills / rules", "");
  for (const f of snap.topSkills) {
    lines.push(`- \`${f.path}\` — ${f.lines}L · ~${f.estTokens} tok`);
  }
  lines.push("", "## Oversized markdown (>400L)", "");
  if (snap.oversizedMd.length === 0) lines.push("- (none)");
  else for (const f of snap.oversizedMd) lines.push(`- \`${f.path}\` — ${f.lines}L`);
  lines.push("", "## Heaviest agent transcripts (this machine)", "");
  for (const f of snap.topTranscripts) {
    lines.push(`- \`${f.path}\` — ~${f.estTokens} tok`);
  }
  lines.push("", "## Checklist (do, then --verify)", "");
  for (const c of snap.checklist) lines.push(`- [ ] ${c}`);
  lines.push(
    "",
    "## Pass / fail rule",
    "",
    "After cleanup, `--verify` **passes** if `hotContextEstTokens` did not grow >5% vs baseline",
    "(and ideally fell). Use `--allow-growth` only when you intentionally added context.",
    "",
  );
  return lines.join("\n");
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const snap = collect();
  const prev = existsSync(BASELINE)
    ? JSON.parse(readFileSync(BASELINE, "utf8"))
    : null;

  if (doVerify) {
    if (!prev?.metrics) {
      console.error("No baseline.json — run without --verify first.");
      process.exit(2);
    }
    const dHot = delta(snap.metrics.hotContextEstTokens, prev.metrics.hotContextEstTokens);
    const dSkill = delta(snap.metrics.skillEstTokens, prev.metrics.skillEstTokens);
    const grewHot = dHot.rel != null && dHot.rel > 0.05;
    const report = {
      ok: allowGrowth || !grewHot,
      baselineTs: prev.ts,
      nowTs: snap.ts,
      hotContextEstTokens: {
        before: prev.metrics.hotContextEstTokens,
        after: snap.metrics.hotContextEstTokens,
        deltaAbs: dHot.abs,
        deltaPct: dHot.rel,
      },
      skillEstTokens: {
        before: prev.metrics.skillEstTokens,
        after: snap.metrics.skillEstTokens,
        deltaAbs: dSkill.abs,
        deltaPct: dSkill.rel,
      },
      oversizedMdCount: {
        before: prev.metrics.oversizedMdCount,
        after: snap.metrics.oversizedMdCount,
        deltaAbs: snap.metrics.oversizedMdCount - prev.metrics.oversizedMdCount,
      },
      proof:
        dHot.rel != null && dHot.rel < 0
          ? `Saved ~${Math.abs(dHot.abs)} est. hot-context tokens (${pct(dHot.rel)})`
          : grewHot
            ? `Hot context grew ${pct(dHot.rel)} — trim session/state or use --allow-growth`
            : "Hot context stable (≤5% growth)",
    };
    const day = snap.ts.slice(0, 10);
    writeFileSync(join(OUT_DIR, `${day}-verify.json`), JSON.stringify(report, null, 2) + "\n");
    // Update baseline only on pass so next week compares to a clean point
    if (report.ok) {
      writeFileSync(BASELINE, JSON.stringify(snap, null, 2) + "\n");
    }
    if (!jsonOnly) {
      console.log(report.ok ? "VERIFY PASS" : "VERIFY FAIL");
      console.log(report.proof);
      console.log(JSON.stringify(report.hotContextEstTokens, null, 2));
    } else {
      console.log(JSON.stringify(report, null, 2));
    }
    process.exit(report.ok ? 0 : 1);
  }

  // Snapshot mode — write report + refresh baseline
  const day = snap.ts.slice(0, 10);
  const mdPath = join(OUT_DIR, `${day}.md`);
  writeFileSync(mdPath, renderMarkdown(snap, prev) + "\n");
  writeFileSync(BASELINE, JSON.stringify(snap, null, 2) + "\n");
  writeFileSync(join(OUT_DIR, `${day}.json`), JSON.stringify(snap, null, 2) + "\n");

  if (jsonOnly) {
    console.log(JSON.stringify({ ok: true, path: mdPath, metrics: snap.metrics }, null, 2));
  } else {
    console.log(`Wrote ${relative(ROOT, mdPath)}`);
    console.log(
      `hotContext~${snap.metrics.hotContextEstTokens} tok · skills~${snap.metrics.skillEstTokens} tok · oversizedMd=${snap.metrics.oversizedMdCount}`,
    );
    if (prev?.metrics) {
      const d = delta(snap.metrics.hotContextEstTokens, prev.metrics.hotContextEstTokens);
      console.log(`vs prior baseline: hotContext ${pct(d.rel)} (${d.abs >= 0 ? "+" : ""}${d.abs} tok)`);
    }
    console.log("Next: act on checklist, then: node .cursor/scripts/ai-workflow-review.mjs --verify");
  }
}

main();
