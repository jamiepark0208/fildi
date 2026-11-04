/**
 * A329 — Stock DB L0+L1 audit (fetch_fundamentals universe × FIELD_DEFS).
 *   pnpm exec tsx src/scripts/stock-db-audit.ts --smoke
 *   pnpm exec tsx src/scripts/stock-db-audit.ts --full
 *   pnpm exec tsx src/scripts/stock-db-audit.ts --full --segment leverage_returns
 *   pnpm exec tsx src/scripts/stock-db-audit.ts --full --segment statement_levels
 *   pnpm exec tsx src/scripts/stock-db-audit.ts --full --segment per_share
 * L2 SEC: artifacts/api-server/scripts/stock-db-audit-l2.py
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import {
  auditFindings,
  db,
  fieldProvenance,
  sourceFundamentals,
  tickerFundamentals,
  tickerRegistry,
} from "@workspace/db";
import { etDateKey } from "../lib/market-hours.js";
import {
  CAUSE_META,
  ERROR_RATE_EXCLUDED_CAUSES,
  rankTopFlags,
  type SpecCause,
} from "../lib/stock-db-audit-l3.js";
import {
  SMOKE_TICKERS,
  auditCell,
  SEGMENT_LEVERAGE_RETURNS_FIELDS,
  SEGMENT_PER_SHARE_FIELDS,
  SEGMENT_STATEMENT_LEVELS_FIELDS,
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
const segmentArg = process.argv.find((a) => a.startsWith("--segment="))?.split("=")[1]
  ?? (process.argv.includes("--segment") ? process.argv[process.argv.indexOf("--segment") + 1] : null);
const segmentLeverage = segmentArg === "leverage_returns";
const segmentStatement = segmentArg === "statement_levels";
const segmentPerShare = segmentArg === "per_share";
if (!smoke && !full) {
  console.error(
    "Usage: stock-db-audit.ts --smoke | --full [--segment leverage_returns|statement_levels|per_share]",
  );
  process.exit(1);
}
const runId = etDateKey();

const AUDIT_FIELDS = segmentLeverage
  ? AUDIT_FIELD_LIST.filter((f) => SEGMENT_LEVERAGE_RETURNS_FIELDS.has(f))
  : segmentStatement
    ? AUDIT_FIELD_LIST.filter((f) => SEGMENT_STATEMENT_LEVELS_FIELDS.has(f))
    : segmentPerShare
      ? AUDIT_FIELD_LIST.filter((f) => SEGMENT_PER_SHARE_FIELDS.has(f))
      : AUDIT_FIELD_LIST;
const CLEAN_SAMPLE_MIN = segmentLeverage || segmentStatement || segmentPerShare ? 400 : 1;
const segmentUsesL1Clean = segmentStatement || segmentPerShare;

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
  const res = await db
    .select({ ticker: tickerFundamentals.ticker })
    .from(tickerFundamentals)
    .innerJoin(tickerRegistry, eq(tickerFundamentals.ticker, tickerRegistry.ticker))
    .where(eq(tickerRegistry.fetchFundamentals, true));
  return res.map((r) => String(r.ticker).toUpperCase()).sort();
}

async function loadModelListTickers(): Promise<Set<string>> {
  const res = await db.execute<{ ticker: string }>(sql`
    SELECT DISTINCT UPPER(ticker) AS ticker FROM model_recs
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM model_recs)
    UNION
    SELECT DISTINCT UPPER(ticker) AS ticker FROM option_score_snapshots
    WHERE scored_date = (SELECT MAX(scored_date) FROM option_score_snapshots)
  `);
  const rows = (Array.isArray(res) ? res : (res as { rows?: { ticker: string }[] }).rows) ?? [];
  return new Set(rows.map((r) => String(r.ticker).toUpperCase()));
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
  const byCause: Record<string, number> = {};
  const byCauseErrorRate: Record<string, number> = {};
  const skipReasons: Record<string, number> = {};
  for (const f of findings) {
    byLayer[f.layer][f.status] += 1;
    if (f.class) {
      byCause[f.class] = (byCause[f.class] ?? 0) + 1;
      if (!ERROR_RATE_EXCLUDED_CAUSES.has(f.class as SpecCause)) {
        byCauseErrorRate[f.class] = (byCauseErrorRate[f.class] ?? 0) + 1;
      }
    }
    if (f.skipReason) skipReasons[f.skipReason] = (skipReasons[f.skipReason] ?? 0) + 1;
  }
  return { byLayer, byCause, byCauseErrorRate, skipReasons };
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
  const okCells: { ticker: string; field: string; gold: number | null; cohort: "clean" }[] = [];
  for (const f of findings) {
    if (f.gold == null) continue;
    const layerOk = segmentUsesL1Clean
      ? f.layer === "L1" && f.status === "ok"
      : f.layer === "L0" && f.status === "ok";
    if (!layerOk) continue;
    okCells.push({ ticker: f.ticker, field: f.field, gold: f.gold, cohort: "clean" });
  }
  const rng = mulberry32(329);
  const n = Math.min(
    okCells.length,
    Math.max(CLEAN_SAMPLE_MIN, Math.ceil(okCells.length * 0.05)),
  );
  const picked: typeof okCells = [];
  const pool = [...okCells];
  while (picked.length < n && pool.length > 0) {
    const i = Math.floor(rng() * pool.length);
    picked.push(pool.splice(i, 1)[0]!);
  }
  writeFileSync(join(OUT_DIR, `l2-sample-${runId}.json`), JSON.stringify({ runId, tickers, sample: picked }, null, 2));
}

type L2Summary = {
  flagged: { judged: number; ok: number; rate: number; ci95: [number, number] };
  clean: { judged: number; ok: number; rate: number; ci95: [number, number] };
};

function readL2Summary(): L2Summary | null {
  const p = join(OUT_DIR, `l2-results-${runId}.json`);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as {
      summary: L2Summary & { runId?: string; cells?: number; cleanMisses?: unknown[] };
    };
    const s = j.summary;
    if (!s?.flagged?.judged || !s?.clean?.judged) return null;
    return { flagged: s.flagged, clean: s.clean };
  } catch {
    return null;
  }
}

function writeReport(
  tickers: string[],
  findings: AuditFinding[],
  modelList: Set<string>,
  l2Summary: L2Summary | null,
) {
  mkdirSync(OUT_DIR, { recursive: true });
  const { byLayer, byCause, byCauseErrorRate, skipReasons } = summarize(findings);
  const flags = findings.filter((f) => f.status === "flag");
  const top = rankTopFlags(flags, modelList, 20);
  const segmentLabel = segmentLeverage
    ? " · segment leverage_returns"
    : segmentStatement
      ? " · segment statement_levels"
      : segmentPerShare
        ? " · segment per_share"
        : "";
  const lines = [
    `# Stock DB audit ${runId} (${smoke && !full ? "smoke" : "full"}${segmentLabel})`,
    "",
    `Tickers: ${tickers.length} (fetch_fundamentals universe) · Fields: ${AUDIT_FIELDS.length} · Cells: ${findings.length}`,
    "",
    "## L0/L1 status",
    `- L0 ok ${byLayer.L0.ok} flag ${byLayer.L0.flag} skip ${byLayer.L0.skip}`,
    `- L1 ok ${byLayer.L1.ok} flag ${byLayer.L1.flag} skip ${byLayer.L1.skip}`,
    "",
    "## L0 skip reasons",
    ...Object.entries(skipReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `- ${r}: ${n}`),
    "",
    "## L3 causes (spec)",
    ...Object.entries(byCause)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => {
        const meta = CAUSE_META[c as SpecCause];
        const ex = ERROR_RATE_EXCLUDED_CAUSES.has(c as SpecCause) ? " [excluded from error rate]" : "";
        return `- ${c}: ${n} — guard ${meta?.guard ?? "?"}${ex}`;
      }),
    "",
    "## L3 causes (error-rate set)",
    ...Object.entries(byCauseErrorRate)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `- ${c}: ${n}`),
    "",
    l2Summary?.flagged && l2Summary?.clean   // an older L2 file has the blended shape only → treat as not run
      ? [
          "## L2 SEC (flagged vs clean sample)",
          `- flagged: judged ${l2Summary.flagged.judged} ok ${l2Summary.flagged.ok} rate ${(l2Summary.flagged.rate * 100).toFixed(1)}% CI95 [${(l2Summary.flagged.ci95[0] * 100).toFixed(1)}%, ${(l2Summary.flagged.ci95[1] * 100).toFixed(1)}%]`,
          `- clean sample: judged ${l2Summary.clean.judged} ok ${l2Summary.clean.ok} rate ${(l2Summary.clean.rate * 100).toFixed(1)}% CI95 [${(l2Summary.clean.ci95[0] * 100).toFixed(1)}%, ${(l2Summary.clean.ci95[1] * 100).toFixed(1)}%] (drawn n≥${CLEAN_SAMPLE_MIN})`,
        ].join("\n")
      : "## L2 SEC sample\n- (run stock-db-audit-l2.py after this)",
    "",
    "## Top 20 by impact (gap × fund field × Model List)",
    ...top.map((f) => `- ${f.ticker} ${f.field} ${f.layer} ${f.class} impact=${f.impact.toFixed(2)} gap=${(f.gap * 100).toFixed(1)}%: ${f.evidence}`),
    "",
  ];
  writeFileSync(join(OUT_DIR, "A329.md"), lines.join("\n") + "\n");
  writeFileSync(
    join(OUT_DIR, `flags-${runId}.json`),
    JSON.stringify(
      {
        runId,
        flags: flags.map((f) => ({ ticker: f.ticker, field: f.field, gold: f.gold, cohort: "flagged" as const })),
      },
      null,
      2,
    ),
  );
}

async function main() {
  const tickers = await loadTickers();
  const modelList = await loadModelListTickers().catch(() => new Set<string>());
  console.log(
    `A329 audit ${smoke && !full ? "smoke" : "full"}${
      segmentLeverage ? " segment1" : segmentStatement ? " segment2" : segmentPerShare ? " segment3" : ""
    } tickers=${tickers.length} fields=${AUDIT_FIELDS.length}`,
  );
  const packs = await buildPacks(tickers);
  const findings: AuditFinding[] = [];

  for (const t of tickers) {
    const pack = packs.get(t);
    if (!pack) continue;
    for (const field of AUDIT_FIELDS) {
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

  await persist(findings).catch((e) => console.warn("persist skipped", e));
  writeCleanSample(findings, tickers);
  writeReport(tickers, findings, modelList, readL2Summary());
  const { byLayer, byCause, skipReasons } = summarize(findings);
  console.log("L0", byLayer.L0, "L1", byLayer.L1, "causes", byCause, "skips", skipReasons);
  console.log(`Wrote ${OUT_DIR}/A329.md and flags-${runId}.json`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
