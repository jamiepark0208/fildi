#!/usr/bin/env node
// Route map (A128 v3, user 10-16: script instead of a second code-graph MCP).
// UI API calls (stock-compare string/template literals starting /api/, plus generated api-client-react hooks)
// ↔ api-server express routes (routes/*.ts, mount prefixes from routes/index.ts, all under /api).
// Usage: node scripts/route-map.mjs [--out .agents/context/route-map.md] [--stdout]
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const UI = path.join(ROOT, "artifacts/stock-compare/src");
const ROUTES = path.join(ROOT, "artifacts/api-server/src/routes");
const GEN = path.join(ROOT, "lib/api-client-react/src/generated/api.ts");
const args = process.argv.slice(2);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(ROOT, ".agents/context/route-map.md");
const rel = (f) => path.relative(ROOT, f);
const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x)) && !/\.test\.|\.spec\./.test(e.name)) out.push(p);
  }
  return out;
}

// Normalize a path to comparable segments: params / template exprs → "*", strip query + trailing slash.
function norm(p) {
  p = p.replace(/\$\{[^}]*\}/g, "*").split("?")[0].replace(/\/+$/, "");
  return p.split("/").filter(Boolean).map((s) => (s.startsWith(":") || s.includes("*") ? "*" : s));
}
const show = (segs) => "/" + segs.join("/");

// ---- server routes ----
const idx = fs.readFileSync(path.join(ROUTES, "index.ts"), "utf8");
const importFile = {}; // routerVar → file
for (const m of idx.matchAll(/import\s+(\w+)\s+from\s+"\.\/([\w-]+)(?:\.js)?"/g)) importFile[m[1]] = m[2];
const prefix = {}; // file → mount prefix
for (const m of idx.matchAll(/router\.use\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g)) if (importFile[m[2]]) prefix[importFile[m[2]]] = m[1];

const routes = [];
for (const f of walk(ROUTES, [".ts"])) {
  const src = fs.readFileSync(f, "utf8");
  const base = path.basename(f, ".ts");
  for (const m of src.matchAll(/\brouter\.(get|post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g)) {
    const full = "/api" + (prefix[base] ?? "") + m[3];
    routes.push({ method: m[1].toUpperCase(), path: full.replace(/\(\?\)|\?(?=\/|$)/g, ""), segs: norm(full.replace(/\?(?=\/|$)/g, "")), at: `${rel(f)}:${lineOf(src, m.index)}`, callers: [] });
  }
}

// ---- UI calls ----
const calls = [];
for (const f of walk(UI, [".ts", ".tsx"])) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/(["'`])(\/api\/[^"'`\s]*)\1/g)) {
    const near = src.slice(m.index, m.index + 300);
    const mm = near.match(/method:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i);
    calls.push({ method: mm ? mm[1].toUpperCase() : null, path: m[2], segs: norm(m[2]), at: `${rel(f)}:${lineOf(src, m.index)}` });
  }
}
// generated hooks: getXUrl → path; UI usage of useX / getX / getXQueryKey
if (fs.existsSync(GEN)) {
  const g = fs.readFileSync(GEN, "utf8");
  const hookPath = {};
  for (const m of g.matchAll(/export const get(\w+)Url\s*=[\s\S]*?`(\/api[^`?]*)/g)) hookPath[m[1]] = m[2];
  const names = Object.keys(hookPath);
  if (names.length) {
    const re = new RegExp(`\\b(?:use|get)(${names.join("|")})(?:QueryKey|QueryOptions|Url)?\\b`, "g");
    for (const f of walk(UI, [".ts", ".tsx"])) {
      const src = fs.readFileSync(f, "utf8");
      if (!src.includes("@workspace/api-client-react")) continue;
      const seen = new Set();
      for (const m of src.matchAll(re)) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        const p = hookPath[m[1]];
        calls.push({ method: null, path: p, segs: norm(p), at: `${rel(f)}:${lineOf(src, m.index)} (hook ${m[0]})` });
      }
    }
  }
}

// ---- match ----
const segMatch = (a, b) => a.length === b.length && a.every((s, i) => s === "*" || b[i] === "*" || s === b[i]);
const orphanCalls = [];
for (const c of calls) {
  let hits = routes.filter((r) => segMatch(r.segs, c.segs) && (!c.method || c.method === r.method));
  if (!hits.length) hits = routes.filter((r) => segMatch(r.segs, c.segs));
  // prefer exact literal segments over wildcard matches
  const score = (r) => r.segs.filter((s, i) => s !== "*" && s === c.segs[i]).length;
  const best = Math.max(-1, ...hits.map(score));
  hits = hits.filter((r) => score(r) === best);
  if (!hits.length) orphanCalls.push(c);
  for (const r of hits) if (!r.callers.includes(c.at)) r.callers.push(c.at);
}

// ---- output ----
routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
const used = routes.filter((r) => r.callers.length);
const unused = routes.filter((r) => !r.callers.length);
const short = (s) => s.replace("artifacts/stock-compare/src/", "ui/").replace("artifacts/api-server/src/routes/", "routes/");
const lines = [
  "# Route map (UI ↔ api-server)",
  `> Generated by \`node scripts/route-map.mjs\` ${new Date().toISOString().slice(0, 10)} — do not hand-edit. ${routes.length} routes · ${used.length} with UI callers · ${unused.length} without · ${orphanCalls.length} UI calls unmatched.`,
  "> Paths: ui/ = artifacts/stock-compare/src/, routes/ = artifacts/api-server/src/routes/. Matching is static (string/template literals + generated hooks); dynamic URLs built from variables are missed.",
  "",
  "## Routes with UI callers",
  ...used.map((r) => `- \`${r.method} ${r.path}\` — ${short(r.at)} ← ${r.callers.map(short).join(", ")}`),
  "",
  "## Routes with no UI caller (scripts, jobs, admin, or dead)",
  ...unused.map((r) => `- \`${r.method} ${r.path}\` — ${short(r.at)}`),
  "",
  "## UI calls with no matching route",
  ...(orphanCalls.length ? orphanCalls.map((c) => `- \`${c.method ?? "?"} ${c.path}\` — ${short(c.at)}`) : ["- none"]),
  "",
];
if (args.includes("--stdout")) process.stdout.write(lines.join("\n"));
else {
  fs.writeFileSync(OUT, lines.join("\n"));
  console.log(`route-map: ${routes.length} routes, ${used.length} with UI callers, ${unused.length} without, ${orphanCalls.length} unmatched UI calls → ${rel(path.resolve(OUT))}`);
}
