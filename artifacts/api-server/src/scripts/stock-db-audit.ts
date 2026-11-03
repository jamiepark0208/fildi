/**
 * A329 — Stock DB L0+L1 audit (all fmp_fundamentals × FIELD_DEFS).
 *   pnpm exec tsx src/scripts/stock-db-audit.ts --smoke
 *   pnpm exec tsx src/scripts/stock-db-audit.ts --full
 * L2 SEC: artifacts/api-server/scripts/stock-db-audit-l2.py
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inArray, sql } from "drizzle-orm";
import {
  auditFindings,
  db,
  fieldProvenance,
  fmpFundamentals,
  pricesHistorical,
  sourceFundamentals,
  tickerFundamentals,
} from "@workspace/db";
import {
  ERROR_CLASS_META,
  SMOKE_TICKERS,
  auditCell,
  type AuditFinding,
  type FundRow,
  type SourceVal,
} from "../lib/stock-db-audit.js";
import { FIELD_DEFS } from "./merge-trusted.js";

const AUDIT_FIELD_LIST = FIELD_DEFS.map((d) => d.tfCol);

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT_DIR = join(REPO, "artifacts/api-server/out/audit");

const args = new Set(process.argv.slice(2));
const smoke = args.has("--smoke");
const full = args.has("--full");
if (!smoke && !full) {
  console.error("Usage: stock-db-audit.ts --smoke | --full");
  process.exit(1);
}
const runId = new Date().toISOString().slice(0, 10);

type TickerPack = {
  ticker: string;
  fund: FundRow;
  price: number | null;
  prov: Map<string, { divergent: boolean; source: string | null; gold: number | null }>;
  sources: Map<string, SourceVal[]>;
};

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

async function loadTickers(): Promise<string[]> {
  if (smoke && !full) return [...SMOKE_TICKERS];
  const rows = await db.select({ ticker: fmpFundamentals.ticker }).from(fmpFundamentals);
  return rows.map((r) => String(r.ticker).toUpperCase()).sort();
}

async function loadPrices(tickers: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tickers.length === 0) return out;
  const inList = sql.join(tickers.map((t) => sql`${t}`), sql`, `);
  const res = await db.execute(sql`
    SELECT DISTINCT ON (UPPER(ticker)) UPPER(ticker) AS ticker, close::float8 AS close
    FROM prices_historical
    WHERE UPPER(ticker) IN (${inList})
    ORDER BY UPPER(ticker), date DESC
  `);
  const list = (Array.isArray(res) ? res : (res as unknown as { rows?: { ticker: string; close: number }[] }).rows) ?? [];
  for (const r of list) out.set(String(r.ticker).toUpperCase(), Number(r.close));
  return out;
}

async function buildPacks(tickers: string[]): Promise<Map<string, TickerPack>> {
  const packs = new Map<string, TickerPack>();
  const prices = await loadPrices(tickers);

  for (const t of tickers) {
    packs.set(t, {
      ticker: t,
      fund: {},
      price: prices.get(t) ?? null,
      prov: new Map(),
      sources: new Map(),
    });
  }

  const tfRows = await db
    .select()
    .from(tickerFundamentals)
    .where(inArray(tickerFundamentals.ticker, tickers));
  for (const row of tfRows) {
    const t = String(row.ticker).toUpperCase();
    const p = packs.get(t);
    if (!p) continue;
    p.fund = row as unknown as FundRow;
  }

  const fpRows = await db
    .select()
    .from(fieldProvenance)
    .where(inArray(fieldProvenance.ticker, tickers));
  for (const row of fpRows) {
    const t = String(row.ticker).toUpperCase();
    const p = packs.get(t);
    if (!p) continue;
    p.prov.set(row.field, {
      divergent: Boolean(row.divergent),
      source: row.winningSource,
      gold: parseNum(row.winningValue),
    });
  }

  const sfRows = await db
    .select()
    .from(sourceFundamentals)
    .where(inArray(sourceFundamentals.ticker, tickers));
  for (const row of sfRows) {
    const t = String(row.ticker).toUpperCase();
    const p = packs.get(t);
    if (!p) continue;
    const field = row.field;
    const val = parseNum(row.value);
    if (val == null) continue;
    const list = p.sources.get(field) ?? [];
    list.push({
      source: row.source,
      field,
      value: val,
      fetchedAt: row.fetchedAt ? String(row.fetchedAt) : null,
    });
    p.sources.set(field, list);
  }

  return packs;
}

function goldForField(pack: TickerPack, field: string): number | null {
  const prov = pack.prov.get(field);
  if (prov?.gold != null) return prov.gold;
  const raw = pack.fund[field];
  return parseNum(raw);
}

function sourcesForField(pack: TickerPack, field: string): SourceVal[] {
  const def = FIELD_DEFS.find((d) => d.tfCol === field);
  if (!def) return pack.sources.get(field) ?? [];
  const out: SourceVal[] = [];
  const seen = new Set<string>();
  for (const [, sfField] of def.priority) {
    for (const s of pack.sources.get(sfField) ?? []) {
      if (seen.has(s.source)) continue;
      seen.add(s.source);
      out.push({ ...s, field: sfField });
    }
  }
  return out;
}

function summarize(findings: AuditFinding[]) {
  const byLayer: Record<string, { ok: number; flag: number; skip: number }> = {
    L0: { ok: 0, flag: 0, skip: 0 },
    L1: { ok: 0, flag: 0, skip: 0 },
  };
  const byClass: Record<string, number> = {};
  for (const f of findings) {
    byLayer[f.layer][f.status] += 1;
    if (f.class) byClass[f.class] = (byClass[f.class] ?? 0) + 1;
  }
  return { byLayer, byClass };
}

async function persist(findings: AuditFinding[]) {
  await db.execute(sql`DELETE FROM audit_findings WHERE run_id = ${runId}`);
  const batch = findings.map((f) => ({
    runId,
    ticker: f.ticker,
    field: f.field,
    layer: f.layer,
    status: f.status,
    gold: f.gold != null ? String(f.gold) : null,
    truth: null,
    truthSource: null,
    class: f.class,
    rootCause: f.rootCause,
    evidence: f.evidence,
    fix: f.fix,
    findingStatus: f.status === "flag" ? "open" : "ok",
  }));
  const chunk = 500;
  for (let i = 0; i < batch.length; i += chunk) {
    await db.insert(auditFindings).values(batch.slice(i, i + chunk));
  }
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function writeCleanSample(findings: AuditFinding[], tickers: string[]) {
  mkdirSync(OUT_DIR, { recursive: true });
  const okCells: { ticker: string; field: string; gold: number | null }[] = [];
  for (const f of findings) {
    if (f.layer !== "L0" || f.status !== "ok" || f.gold == null) continue;
    okCells.push({ ticker: f.ticker, field: f.field, gold: f.gold });
  }
  const rng = mulberry32(329);
  const n = Math.max(1, Math.ceil(okCells.length * 0.05));
  const picked: typeof okCells = [];
  const pool = [...okCells];
  while (picked.length < n && pool.length > 0) {
    const i = Math.floor(rng() * pool.length);
    picked.push(pool.splice(i, 1)[0]!);
  }
  writeFileSync(join(OUT_DIR, `l2-sample-${runId}.json`), JSON.stringify({ runId, tickers, sample: picked }, null, 2));
}

function writeReport(
  tickers: string[],
  findings: AuditFinding[],
  l2Summary: { judged: number; ok: number; ci: { lo: number; hi: number; rate: number } } | null,
) {
  mkdirSync(OUT_DIR, { recursive: true });
  const { byLayer, byClass } = summarize(findings);
  const flags = findings.filter((f) => f.status === "flag");
  const top = flags.slice(0, 20);
  const lines = [
    `# Stock DB audit ${runId} (${smoke && !full ? "smoke" : "full"})`,
    "",
    `Tickers: ${tickers.length} · Fields: ${AUDIT_FIELD_LIST.length} · Cells: ${findings.length}`,
    "",
    "## L0/L1 status",
    `- L0 ok ${byLayer.L0.ok} flag ${byLayer.L0.flag} skip ${byLayer.L0.skip}`,
    `- L1 ok ${byLayer.L1.ok} flag ${byLayer.L1.flag} skip ${byLayer.L1.skip}`,
    "",
    "## Classes",
    ...Object.entries(byClass)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `- ${c}: ${n} — guard ${ERROR_CLASS_META[c as keyof typeof ERROR_CLASS_META]?.guard ?? "?"}`),
    "",
    l2Summary
      ? `## L2 SEC sample\n- judged ${l2Summary.judged} ok ${l2Summary.ok} rate ${(l2Summary.ci.rate * 100).toFixed(1)}% CI95 [${(l2Summary.ci.lo * 100).toFixed(1)}%, ${(l2Summary.ci.hi * 100).toFixed(1)}%]`
      : "## L2 SEC sample\n- (run stock-db-audit-l2.py after this)",
    "",
    "## Top 20 flags",
    ...top.map((f) => `- ${f.ticker} ${f.field} ${f.layer} ${f.class}: ${f.evidence}`),
    "",
  ];
  writeFileSync(join(OUT_DIR, "A329.md"), lines.join("\n") + "\n");
  writeFileSync(
    join(OUT_DIR, `flags-${runId}.json`),
    JSON.stringify({ runId, flags: flags.map((f) => ({ ticker: f.ticker, field: f.field, gold: f.gold })) }, null, 2),
  );
}

async function main() {
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS audit_findings (
    id serial PRIMARY KEY,
    run_id text NOT NULL,
    ticker text NOT NULL,
    field text NOT NULL,
    layer text NOT NULL,
    status text NOT NULL,
    gold numeric,
    truth numeric,
    truth_source text,
    class text,
    root_cause text,
    evidence text,
    fix text,
    finding_status text NOT NULL DEFAULT 'open',
    created_at timestamptz NOT NULL DEFAULT now()
  )`));

  const tickers = await loadTickers();
  console.log(`A329 audit ${smoke && !full ? "smoke" : "full"} tickers=${tickers.length} fields=${AUDIT_FIELD_LIST.length}`);
  const packs = await buildPacks(tickers);
  const findings: AuditFinding[] = [];

  for (const t of tickers) {
    const pack = packs.get(t);
    if (!pack) continue;
    for (const field of AUDIT_FIELD_LIST) {
      const gold = goldForField(pack, field);
      const prov = pack.prov.get(field);
      findings.push(
        ...auditCell({
          ticker: t,
          field,
          gold,
          price: pack.price,
          fund: pack.fund,
          sources: sourcesForField(pack, field),
          divergent: prov?.divergent ?? false,
          winningSource: prov?.source ?? null,
        }),
      );
    }
  }

  await persist(findings);
  writeCleanSample(findings, tickers);
  writeReport(tickers, findings, null);
  const { byLayer, byClass } = summarize(findings);
  console.log("L0", byLayer.L0, "L1", byLayer.L1, "classes", byClass);
  console.log(`Wrote ${OUT_DIR}/A329.md and flags-${runId}.json`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
