/**
 * Database Agent — resolve a batch of Needs Review cells without burning APIs.
 *
 * Loads bronze (source_fundamentals) + local research (WRDS finratio, LSEG gold_audit)
 * in batched SQL, decides with database-agent-resolve.ts, writes manual_overrides with
 * agent:v1 trail notes, re-resolves provenance.
 *
 *   pnpm exec tsx src/scripts/database-agent-resolve-nr.ts
 *   pnpm exec tsx src/scripts/database-agent-resolve-nr.ts --limit=20 --dry-run
 *   pnpm exec tsx src/scripts/database-agent-resolve-nr.ts --fields=priceToBook,currentRatio
 *   pnpm exec tsx src/scripts/database-agent-resolve-nr.ts --limit=18 --factset
 *
 * Default: 0 live vendor calls (bronze + WRDS + LSEG + derived P/B).
 * `--factset`: one batched FactSet referee for tickers still skipped, then re-decide.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db, fieldProvenance, manualOverrides, sourceFundamentals, tickerFundamentals,
} from "@workspace/db";
import { FIELD_DEFS, resolveField, writeProvenance } from "./merge-trusted.js";
import {
  WRDS_FIELD_MAP,
  decideNeedsReview,
  encodeAgentNote,
  type SourceQuote,
} from "../lib/database-agent-resolve.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dir, "../../../..");
const LOG = join(REPO, ".agents/context/database-agent-log.md");

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : 18;
const DRY = process.argv.includes("--dry-run");
const USE_FACTSET = process.argv.includes("--factset");
const fieldsArg = process.argv.find((a) => a.startsWith("--fields="));
const FIELD_FILTER = fieldsArg
  ? new Set(fieldsArg.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean))
  : null;

type NrItem = { ticker: string; field: string; winningSource: string | null; winningValue: number | null };

async function pickBatch(limit: number): Promise<NrItem[]> {
  // Diversify: take top fields by NR count, round-robin a few from each.
  const fieldCounts = await db.execute(sql`
    SELECT field, COUNT(*)::int AS n
    FROM field_provenance
    WHERE divergent = true AND is_override = false
    GROUP BY field
    ORDER BY n DESC
    LIMIT 8
  `);
  const fields = ((fieldCounts as any).rows ?? fieldCounts)
    .map((r: { field: string }) => r.field)
    .filter((f: string) => !FIELD_FILTER || FIELD_FILTER.has(f));

  const perField = Math.max(2, Math.ceil(limit / Math.max(fields.length, 1)));
  const out: NrItem[] = [];
  const seen = new Set<string>();

  for (const field of fields) {
    const rows = await db
      .select({
        ticker: fieldProvenance.ticker,
        field: fieldProvenance.field,
        winningSource: fieldProvenance.winningSource,
        winningValue: fieldProvenance.winningValue,
      })
      .from(fieldProvenance)
      .where(and(eq(fieldProvenance.divergent, true), eq(fieldProvenance.isOverride, false), eq(fieldProvenance.field, field)))
      .limit(perField * 2);

    for (const r of rows) {
      const key = `${r.ticker}:${r.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ticker: r.ticker,
        field: r.field,
        winningSource: r.winningSource,
        winningValue: r.winningValue != null ? Number(r.winningValue) : null,
      });
      if (out.length >= limit) return out;
      if (out.filter((x) => x.field === field).length >= perField) break;
    }
  }
  return out;
}

async function loadBronze(tickers: string[]): Promise<Map<string, Map<string, Map<string, number>>>> {
  // ticker → sfField → source → value
  const index = new Map<string, Map<string, Map<string, number>>>();
  if (tickers.length === 0) return index;
  const rows = await db
    .select()
    .from(sourceFundamentals)
    .where(inArray(sourceFundamentals.ticker, tickers));
  for (const row of rows) {
    const val = parseFloat(String(row.value));
    if (!Number.isFinite(val)) continue;
    if (!index.has(row.ticker)) index.set(row.ticker, new Map());
    const byField = index.get(row.ticker)!;
    if (!byField.has(row.field)) byField.set(row.field, new Map());
    byField.get(row.field)!.set(row.source, val);
  }
  return index;
}

async function loadWrds(tickers: string[]): Promise<Map<string, Record<string, number | null>>> {
  const map = new Map<string, Record<string, number | null>>();
  if (tickers.length === 0) return map;
  try {
    const r = await db.execute(sql`
      SELECT ticker, pe_exi, bm, ps, roe, roa, npm, gpm, de_ratio, curr_ratio, fetched_at
      FROM wrds_research.finratio_snapshot
      WHERE ticker IN (${sql.join(tickers.map((t) => sql`${t}`), sql`, `)})
    `);
    for (const row of ((r as any).rows ?? r) as any[]) {
      map.set(String(row.ticker).toUpperCase(), row);
    }
  } catch (e) {
    console.warn("[db-agent] WRDS finratio unavailable:", (e as Error).message);
  }
  return map;
}

async function loadLsegAudit(
  pairs: Array<{ ticker: string; field: string }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (pairs.length === 0) return out;
  try {
    const r = await db.execute(sql`
      SELECT ticker, field, lseg_value
      FROM lseg_research.gold_audit
      WHERE (ticker, field) IN (${sql.join(
        pairs.map((p) => sql`(${p.ticker}, ${p.field})`),
        sql`, `,
      )})
    `);
    for (const row of ((r as any).rows ?? r) as any[]) {
      const v = Number(row.lseg_value);
      if (Number.isFinite(v)) out.set(`${row.ticker}:${row.field}`, v);
    }
  } catch {
    // gold_audit may not exist — OK
  }
  return out;
}

function freeQuotesForField(
  byField: Map<string, Map<string, number>> | undefined,
  field: string,
): { free: SourceQuote[]; factset: SourceQuote | null } {
  const def = FIELD_DEFS.find((d) => (d.tfCol as string) === field);
  if (!def || !byField) return { free: [], factset: null };
  const seen = new Set<string>();
  const free: SourceQuote[] = [];
  let factset: SourceQuote | null = null;
  for (const [src, sfField] of def.priority) {
    if (seen.has(src)) continue;
    seen.add(src);
    const val = byField.get(sfField)?.get(src) ?? byField.get(field)?.get(src);
    if (val == null || !Number.isFinite(val)) continue;
    if (src === "factset") {
      factset = { source: "factset", value: val, cached: true };
    } else {
      free.push({ source: src, value: val, cached: true });
    }
  }
  return { free, factset };
}

function researchQuotes(
  field: string,
  wrdsRow: Record<string, number | null> | undefined,
  lsegVal: number | undefined,
): SourceQuote[] {
  const out: SourceQuote[] = [];
  const map = WRDS_FIELD_MAP[field];
  if (map && wrdsRow) {
    const raw = wrdsRow[map.col];
    if (raw != null && Number.isFinite(Number(raw))) {
      const v = map.transform ? map.transform(Number(raw)) : Number(raw);
      if (Number.isFinite(v)) out.push({ source: "wrds", value: v, cached: true });
    }
  }
  if (lsegVal != null && Number.isFinite(lsegVal)) {
    out.push({ source: "lseg", value: lsegVal, cached: true });
  }
  return out;
}

async function syncOverrideFlags(ticker: string) {
  const rows = await db
    .select({ field: manualOverrides.field, note: manualOverrides.note })
    .from(manualOverrides)
    .where(eq(manualOverrides.ticker, ticker));
  const overrideFlags = rows.length > 0 ? rows.map((r) => r.field).join(",") : null;
  const agentOverrideFlags =
    rows.filter((r) => typeof r.note === "string" && r.note.startsWith("agent:")).map((r) => r.field).join(",") ||
    null;
  await db
    .insert(tickerFundamentals)
    .values({ ticker, overrideFlags, agentOverrideFlags } as any)
    .onConflictDoUpdate({
      target: tickerFundamentals.ticker,
      set: { overrideFlags, agentOverrideFlags } as any,
    });
}

async function ensureAgentFlagsColumn() {
  await db.execute(sql`
    ALTER TABLE ticker_fundamentals
    ADD COLUMN IF NOT EXISTS agent_override_flags text
  `);
}

function appendLog(lines: string[]) {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, lines.join("\n") + "\n");
  } catch (e) {
    console.warn("[db-agent] log write failed:", (e as Error).message);
  }
}

async function main() {
  await ensureAgentFlagsColumn();
  const beforeR = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM field_provenance WHERE divergent = true AND is_override = false
  `);
  const before = Number(((beforeR as any).rows ?? beforeR)[0]?.n ?? 0);

  const batch = await pickBatch(LIMIT);
  console.log(`[db-agent] Needs Review before: ${before}`);
  console.log(`[db-agent] batch ${batch.length}${DRY ? " (dry-run)" : ""}`);

  const tickers = [...new Set(batch.map((b) => b.ticker))];
  const [bronze, wrds, lseg, derivedRows] = await Promise.all([
    loadBronze(tickers),
    loadWrds(tickers),
    loadLsegAudit(batch),
    db.execute(sql`
      SELECT tf.ticker,
        tf.total_stockholders_equity::float8 AS equity,
        tf.shares_outstanding::float8 AS shares,
        (
          SELECT close::float8 FROM prices_historical ph
          WHERE ph.ticker = tf.ticker ORDER BY ph.date DESC LIMIT 1
        ) AS price
      FROM ticker_fundamentals tf
      WHERE tf.ticker IN (${sql.join(tickers.map((t) => sql`${t}`), sql`, `)})
    `),
  ]);

  // Prefer FactSet equity for derived P/B when present (AAOI lesson: gold equity can be contested).
  const derivedPb = new Map<string, number>();
  for (const row of ((derivedRows as any).rows ?? derivedRows) as any[]) {
    const t = String(row.ticker).toUpperCase();
    const price = Number(row.price);
    const goldEq = Number(row.equity);
    const shares = Number(row.shares);
    const fsEq = bronze.get(t)?.get("totalStockholdersEquity")?.get("factset")
      ?? bronze.get(row.ticker)?.get("totalStockholdersEquity")?.get("factset");
    const eq = fsEq != null && fsEq > 0 ? fsEq : goldEq;
    if (price > 0 && eq > 0 && shares > 0) {
      derivedPb.set(t, price / (eq / shares));
    }
  }

  let resolved = 0;
  let skipped = 0;
  const decisions: string[] = [];

  for (const item of batch) {
    const { free, factset } = freeQuotesForField(bronze.get(item.ticker), item.field);
    const research = researchQuotes(
      item.field,
      wrds.get(item.ticker.toUpperCase()),
      lseg.get(`${item.ticker}:${item.field}`),
    );
    const derived =
      item.field === "priceToBook" && derivedPb.has(item.ticker.toUpperCase())
        ? { source: "derived", value: derivedPb.get(item.ticker.toUpperCase())!, cached: true }
        : null;
    const decision = decideNeedsReview({ field: item.field, free, factset, research, derived });

    if (decision.action === "skip") {
      skipped++;
      decisions.push(
        `- SKIP ${item.ticker}.${item.field} (${decision.reason}) free=[${free.map((f) => `${f.source}:${f.value}`).join(", ")}] research=[${research.map((r) => `${r.source}:${r.value}`).join(", ")}]`,
      );
      continue;
    }

    const note = encodeAgentNote(decision);
    decisions.push(
      `- OK ${item.ticker}.${item.field} → ${decision.source}=${decision.value} (${decision.reason}) note=${note.slice(0, 120)}…`,
    );

    if (DRY) {
      resolved++;
      continue;
    }

    const literal =
      decision.source === "manual" ? String(decision.value) : null;
    await db
      .insert(manualOverrides)
      .values({
        ticker: item.ticker,
        field: item.field,
        overrideSource: decision.source,
        overrideValue: literal,
        note,
      })
      .onConflictDoUpdate({
        target: [manualOverrides.ticker, manualOverrides.field],
        set: {
          overrideSource: decision.source,
          overrideValue: literal,
          note,
          createdAt: new Date(),
        },
      });

    const result = await resolveField(item.ticker, item.field);
    if (result) {
      const now = new Date();
      await Promise.all([
        db
          .insert(tickerFundamentals)
          .values({ ticker: item.ticker, [item.field]: result.value } as any)
          .onConflictDoUpdate({
            target: tickerFundamentals.ticker,
            set: { [item.field]: result.value } as any,
          }),
        writeProvenance(item.ticker, item.field, { ...result, isOverride: true, divergent: false }, now),
      ]);
    }
    // Clear this field from discrepancy_flags so the sky cell tint drops with NR.
    const flagRow = await db
      .select({ discrepancyFlags: tickerFundamentals.discrepancyFlags })
      .from(tickerFundamentals)
      .where(eq(tickerFundamentals.ticker, item.ticker))
      .limit(1);
    const nextFlags =
      (flagRow[0]?.discrepancyFlags ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((f) => f && f !== item.field)
        .join(",") || null;
    await db
      .insert(tickerFundamentals)
      .values({ ticker: item.ticker, discrepancyFlags: nextFlags } as any)
      .onConflictDoUpdate({
        target: tickerFundamentals.ticker,
        set: { discrepancyFlags: nextFlags } as any,
      });

    await syncOverrideFlags(item.ticker);
    resolved++;
  }

  // Optional second pass: batched FactSet for still-ambiguous tickers, then re-decide.
  if (USE_FACTSET && !DRY && skipped > 0) {
    const skipTickers = [
      ...new Set(
        decisions
          .filter((l) => l.startsWith("- SKIP "))
          .map((l) => l.split(" ")[2]?.split(".")[0])
          .filter(Boolean) as string[],
      ),
    ];
    if (skipTickers.length > 0) {
      console.log(`[db-agent] FactSet batch for ${skipTickers.length} skipped tickers…`);
      const { runFactsetReferee } = await import("../lib/factset-referee.js");
      const ref = await runFactsetReferee({ tickers: skipTickers, maxTickers: skipTickers.length });
      console.log("[db-agent] factset result", ref);
      // Reload bronze for those tickers and retry skips only
      const bronze2 = await loadBronze(skipTickers);
      for (const item of batch) {
        if (!skipTickers.includes(item.ticker)) continue;
        const { free, factset } = freeQuotesForField(bronze2.get(item.ticker), item.field);
        if (!factset) continue;
        const decision = decideNeedsReview({
          field: item.field,
          free,
          factset,
          research: researchQuotes(
            item.field,
            wrds.get(item.ticker.toUpperCase()),
            lseg.get(`${item.ticker}:${item.field}`),
          ),
          derived:
            item.field === "priceToBook" && derivedPb.has(item.ticker.toUpperCase())
              ? { source: "derived", value: derivedPb.get(item.ticker.toUpperCase())!, cached: true }
              : null,
        });
        if (decision.action === "skip") continue;
        const note = encodeAgentNote(decision, "after_factset");
        const literal = decision.source === "manual" ? String(decision.value) : null;
        await db
          .insert(manualOverrides)
          .values({
            ticker: item.ticker,
            field: item.field,
            overrideSource: decision.source,
            overrideValue: literal,
            note,
          })
          .onConflictDoUpdate({
            target: [manualOverrides.ticker, manualOverrides.field],
            set: {
              overrideSource: decision.source,
              overrideValue: literal,
              note,
              createdAt: new Date(),
            },
          });
        const result = await resolveField(item.ticker, item.field);
        if (result) {
          const now = new Date();
          await Promise.all([
            db
              .insert(tickerFundamentals)
              .values({ ticker: item.ticker, [item.field]: result.value } as any)
              .onConflictDoUpdate({
                target: tickerFundamentals.ticker,
                set: { [item.field]: result.value } as any,
              }),
            writeProvenance(item.ticker, item.field, { ...result, isOverride: true, divergent: false }, now),
          ]);
        }
        await syncOverrideFlags(item.ticker);
        resolved++;
        skipped = Math.max(0, skipped - 1);
        decisions.push(
          `- OK-FS ${item.ticker}.${item.field} → ${decision.source}=${decision.value} (${decision.reason})`,
        );
      }
    }
  }

  const afterR = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM field_provenance WHERE divergent = true AND is_override = false
  `);
  const after = Number(((afterR as any).rows ?? afterR)[0]?.n ?? 0);

  console.log(`[db-agent] resolved=${resolved} skipped=${skipped} NR ${before}→${after} (Δ ${after - before})`);
  for (const line of decisions) console.log(line);

  appendLog([
    "",
    `## ${new Date().toISOString().slice(0, 16)} Z — resolve-nr ${DRY ? "dry-run " : ""}${USE_FACTSET ? "factset " : ""}limit=${LIMIT}`,
    `NR ${before}→${after} (Δ ${after - before}); resolved=${resolved} skipped=${skipped}`,
    ...decisions,
    "",
  ]);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
