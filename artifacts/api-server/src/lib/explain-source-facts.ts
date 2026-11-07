/**
 * A356 phase 3 — synthesized per-source lines for Explain AI prompts (DB-only, no vendors).
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { withDeadline } from "./yahoo-client.js";
import { logger } from "./logger.js";
import { buildStreetSynthesis } from "./breakdown-enrichment.js";
import { readTurningPointScores } from "./turning-point-scores.js";

const READ_MS = 1500;
const MAX_LINES = 10;

type SqlRows<T> = T[] | { rows: T[] };
function rowsOf<T>(r: SqlRows<T>): T[] {
  return Array.isArray(r) ? r : r.rows ?? [];
}

export function formatMmDd(isoOrDate: string | null | undefined): string {
  if (!isoOrDate) return "—";
  const d = isoOrDate.slice(0, 10);
  const m = d.slice(5, 7);
  const day = d.slice(8, 10);
  if (!m || !day) return "—";
  return `${m}-${day}`;
}

type MediaSample = { pct?: number | null; thin?: boolean | null; pool_median?: number | null };

/** Cross-sectional desk-media label (matches desk-sentiment-section pctLabel). */
export function mediaSentimentInterpretation(
  pct: number | null | undefined,
  thin: boolean | null | undefined,
  n: number | null | undefined,
): string {
  if (thin) return "thin sample, ignore";
  if (pct == null) return "context, not a signal";
  const nStr = n != null ? `, n ${n}` : "";
  if (pct >= 80) return `bullish vs peers${nStr}`;
  if (pct <= 20) return `cautious vs peers${nStr}`;
  return `neutral vs peers (p${pct})${nStr}`;
}

export function formatMediaSourceFact(
  sourceLabel: string,
  asOf: string,
  score: number | null,
  sample: MediaSample | null | undefined,
  n: number | null,
): string {
  const mmdd = formatMmDd(asOf);
  const thin = sample?.thin === true;
  const pct = sample?.pct;
  const value = thin
    ? "thin sample"
    : pct != null
      ? `p${pct}${score != null ? ` (${score.toFixed(2)})` : ""}`
      : score != null
        ? score.toFixed(2)
        : "n/a";
  const interp = mediaSentimentInterpretation(pct, thin, n);
  return `${sourceLabel} ${mmdd}: ${value} — ${interp}; context, not a signal`;
}

function parseSample(raw: unknown): MediaSample | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as MediaSample;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await withDeadline(fn(), READ_MS, `explain-source ${label}`);
  } catch (err) {
    logger.warn({ err: String(err), label }, "explain-source-facts: read dropped");
    return null;
  }
}

function streetReason(street: Awaited<ReturnType<typeof buildStreetSynthesis>>): string {
  if (street.conflicts[0]?.text) return street.conflicts[0].text;
  if (street.path.summary) return street.path.summary;
  if (street.level.summary) return street.level.summary;
  return `tone ${street.tone}`;
}

function truncateClaim(s: string, max = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** DB reads only; each sub-read bounded by READ_MS; returns ≤ MAX_LINES facts. */
export async function gatherSourceFacts(ticker: string): Promise<string[]> {
  const t = ticker.toUpperCase();
  const facts: string[] = [];

  const streetP = timed("street", async () => {
    const sig = rowsOf<{ price_close: number | null; pt_median: number | null; as_of: string }>(
      (await db.execute(sql`
        SELECT price_close::float8 AS price_close, pt_median::float8 AS pt_median, as_of::text
        FROM lseg_research.signals_daily WHERE ticker = ${t} ORDER BY as_of DESC LIMIT 1`)) as SqlRows<never>,
    )[0];
    const street = await buildStreetSynthesis({
      ticker: t,
      recommendations: null,
      targetMean: sig?.pt_median ?? null,
      price: sig?.price_close ?? null,
    });
    const asOf = sig?.as_of ?? null;
    return `Street ${formatMmDd(asOf)}: ${street.tone} — ${streetReason(street)}; context, not a signal`;
  });

  const mediaP = timed("media", async () => {
    const ok = rowsOf<{ ok: boolean }>(
      (await db.execute(sql`
        SELECT to_regclass('watchlist_sync.media_sentiment_daily') IS NOT NULL AS ok`)) as SqlRows<{ ok: boolean }>,
    )[0]?.ok;
    if (!ok) return [] as string[];
    const rows = rowsOf<{
      as_of: string;
      source: string;
      score: number | null;
      n: number | null;
      sample: unknown;
    }>(
      (await db.execute(sql`
        SELECT DISTINCT ON (source)
          as_of::text, source, score::float8 AS score, n, sample
        FROM watchlist_sync.media_sentiment_daily
        WHERE ticker = ${t} AND source IN ('stocktwits', 'call_tone')
        ORDER BY source, as_of DESC`)) as SqlRows<never>,
    );
    const labels: Record<string, string> = { stocktwits: "StockTwits", call_tone: "Call tone" };
    return rows.map((r) =>
      formatMediaSourceFact(labels[r.source] ?? r.source, r.as_of, r.score, parseSample(r.sample), r.n),
    );
  });

  const shortP = timed("short", async () => {
    const lseg = rowsOf<{ short_pct: number | null; as_of: string }>(
      (await db.execute(sql`
        SELECT short_pct::float8 AS short_pct, as_of::text FROM lseg_research.signals_daily
        WHERE ticker = ${t} ORDER BY as_of DESC LIMIT 1`)) as SqlRows<never>,
    )[0];
    if (lseg?.short_pct == null) return null;
    const poly = rowsOf<{ days_to_cover: number | null; settlement_date: string }>(
      (await db.execute(sql`
        SELECT days_to_cover::float8 AS days_to_cover, settlement_date::text
        FROM short_interest_history
        WHERE ticker = ${t} AND source = 'polygon' ORDER BY settlement_date DESC LIMIT 1`)) as SqlRows<never>,
    )[0];
    const dtc = poly?.days_to_cover != null ? `, Polygon ${poly.days_to_cover.toFixed(1)}d to cover` : "";
    return `Short ${formatMmDd(lseg.as_of)}: ${lseg.short_pct.toFixed(1)}% float${dtc} — context, not a signal`;
  });

  const deskP = timed("desk_facts", async () => {
    const rows = rowsOf<{ claim: string; received_at: string; source_tier: string }>(
      (await db.execute(sql`
        SELECT claim, received_at::text, source_tier FROM desk_facts
        WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(tickers) x WHERE x = ${t})
          AND source_tier IN ('A', 'B')
          AND received_at > now() - interval '14 days'
        ORDER BY received_at DESC LIMIT 3`)) as SqlRows<never>,
    );
    return rows.map(
      (r) =>
        `Desk brief ${formatMmDd(r.received_at)}: ${truncateClaim(r.claim)} — tier ${r.source_tier}; context, not a signal`,
    );
  });

  const ivP = timed("iv_rank", async () => {
    const row = rowsOf<{ pctile: number | null; source: string | null; date: string }>(
      (await db.execute(sql`
        SELECT pctile::float8 AS pctile, source, date::text FROM watchlist_sync.iv_rank_daily
        WHERE ticker = ${t} ORDER BY date DESC LIMIT 1`)) as SqlRows<never>,
    )[0];
    if (row?.pctile == null) return null;
    const pct = Math.round(row.pctile * 100);
    const src = row.source ?? "resolved";
    return `IV rank ${formatMmDd(row.date)}: ${pct}/100 (${src}) — context, not a signal`;
  });

  const earnP = timed("earnings", async () => {
    const row = rowsOf<{ earnings_days_out: number | null }>(
      (await db.execute(sql`
        SELECT earnings_days_out FROM ticker_technicals WHERE ticker = ${t} LIMIT 1`)) as SqlRows<never>,
    )[0];
    if (row?.earnings_days_out == null) return null;
    const d = row.earnings_days_out;
    const when = d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
    return `Earnings ${formatMmDd(new Date().toISOString())}: next report ${when} — context, not a signal`;
  });

  const tpP = timed("turning_point", async () => {
    const tp = await readTurningPointScores(t);
    if (!tp.line) return null;
    return `Turning point ${formatMmDd(tp.asOf)}: shadow — ${tp.line} (S151 UNPROVEN A341); context, not a signal`;
  });

  const [street, media, shortL, desk, iv, earn, tp] = await Promise.all([
    streetP, mediaP, shortP, deskP, ivP, earnP, tpP,
  ]);

  if (street) facts.push(street);
  if (media?.length) facts.push(...media);
  if (shortL) facts.push(shortL);
  if (desk?.length) facts.push(...desk);
  if (iv) facts.push(iv);
  if (earn) facts.push(earn);
  if (tp) facts.push(tp);

  return facts.slice(0, MAX_LINES);
}

export function sourceFactsBlock(facts: string[] | undefined): string {
  if (!facts?.length) return "";
  return `Desk data sources (context only — not trade signals unless a validated study says otherwise):\n${facts.map((l) => `- ${l}`).join("\n")}`;
}

export function sourceFactsKey(facts: string[] | undefined): string {
  const dayBucket = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  const f = facts ?? [];
  if (!f.length) return `sf${dayBucket}_0`;
  const h = f.join("|").length;
  return `sf${dayBucket}_${f.length}_${h}_${f[0].slice(0, 24)}`;
}
