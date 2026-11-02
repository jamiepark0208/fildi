/**
 * D1 (briefs dig, 10-30): ONE extractor for desk emails → typed facts in `desk_facts`.
 * Every consumer (Live, earnings notes briefs_for, the D3 dig) reads these rows instead of its own parser (B19).
 *
 * Haiku extracts; code guards: kind ∈ DESK_FACT_KINDS, every number in a fact must appear in the email (else the fact
 * is dropped), tickers must be in the universe or written in the email. Source tier is code, not model (skill § 1).
 * Plan: research/common/briefs-dig-plan-2026-10-30.md · eval: src/scripts/desk-facts-eval.ts.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { callHaiku, HAIKU_MODEL } from "./haiku.js";
import { cleanBodyNoise } from "./desk-commentary-normalize.js";
import { logger } from "./logger.js";

export const DESK_FACTS_VERSION = 4;

export const DESK_FACT_KINDS = [
  "analyst_action", "earnings_detail", "guidance_calendar", "macro_number", "market_structure",
  "cross_company_theme", "corporate_event", "geopolitics", "shock_risk", "opinion", "vendor_signal",
] as const;
export type DeskFactKind = (typeof DESK_FACT_KINDS)[number];

export interface DeskFact {
  kind: DeskFactKind;
  tickers: string[];
  claim: string;
  numbers: string[];
  checkable: boolean;
  horizon: string | null;
  /** "model" = Haiku · "list" = code-read earnings-timing list (v3: Haiku truncates 100+ name calendars) */
  origin?: "model" | "list";
}

export interface ExtractResult {
  facts: DeskFact[];
  dropped: { numbers: number; kind: number; tickers: number };
  inputTokens: number;
  outputTokens: number;
}

/** Bodies above this are cut (Haiku context is fine; output budget is the limit). 10-30 max body = 114k. */
const MAX_BODY_CHARS = 120_000;
const MAX_FACTS = 150;
/** v2: long emails are extracted in line-aligned chunks (v1 recall 0.48 — one call stopped at ~60–150 facts on 30–70k digests). */
const CHUNK_CHARS = 15_000;

export async function ensureDeskFactsTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS desk_facts (
      id serial PRIMARY KEY,
      commentary_id integer NOT NULL REFERENCES desk_commentaries(id) ON DELETE CASCADE,
      kind text NOT NULL,
      tickers jsonb NOT NULL DEFAULT '[]'::jsonb,
      claim text NOT NULL,
      numbers jsonb NOT NULL DEFAULT '[]'::jsonb,
      source_tier char(1) NOT NULL,
      checkable boolean NOT NULL DEFAULT false,
      horizon text,
      received_at timestamptz NOT NULL,
      extractor_version integer NOT NULL
    )`);
  await db.execute(sql`ALTER TABLE desk_facts ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'model'`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS desk_facts_commentary_idx ON desk_facts (commentary_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS desk_facts_kind_day_idx ON desk_facts (kind, received_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS desk_facts_tickers_idx ON desk_facts USING gin (tickers)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS desk_fact_runs (
      commentary_id integer PRIMARY KEY REFERENCES desk_commentaries(id) ON DELETE CASCADE,
      extractor_version integer NOT NULL,
      body_sha text NOT NULL,
      model text NOT NULL,
      status text NOT NULL,
      n_facts integer NOT NULL DEFAULT 0,
      dropped jsonb NOT NULL DEFAULT '{}'::jsonb,
      input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0,
      error text,
      ran_at timestamptz NOT NULL DEFAULT now()
    )`);
}

/** Skill § 1 source tiers. A reported facts · B reported + framing · C pointers · D vendor signals / promo. */
export function sourceTier(source: string, kind: string, subject: string): "A" | "B" | "C" | "D" {
  const s = source.toLowerCase();
  if (s.startsWith("factset") || s === "lseg") return "A";
  if (s.includes("danelfin") || s === "zerohedge") return "D";
  if (s === "tipranks") return /strong buy|top \d|best/i.test(subject) ? "D" : "C";
  if (s.includes("gurufocus") || kind === "gurufocus") return "C";
  return "B";
}

export function cleanForExtract(body: string): string {
  return cleanBodyNoise(body.replace(/\r/g, ""))
    .replace(/<https?:\/\/[^>]*>|\(https?:\/\/[^)]*\)|https?:\/\/\S+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, MAX_BODY_CHARS);
}

/** Numeric tokens, commas dropped, trailing decimal zeros trimmed ("1,250.50" → "1250.5"). */
export function numberTokens(text: string): string[] {
  return [...text.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)].map((m) => {
    let t = m[0].replace(/,/g, "");
    if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
    return t;
  });
}

const PROMPT = `You extract facts from one market newsletter email for a trading desk. Output ONLY a JSON array, no prose.
Each element: {"kind": K, "tickers": [...], "claim": "...", "numbers": [...], "checkable": bool, "horizon": "..."}
K is one of:
- analyst_action: named rating change, initiation, price-target change, or "N new analyst ratings" about a named company
- earnings_detail: a company's reported results (revenue/EPS/segments, beat/miss vs consensus, post-print stock move)
- guidance_calendar: company guidance/outlook figures, or dated upcoming events (earnings dates, data releases, IPOs, Fed meetings)
- macro_number: an economic figure or market-implied probability (CPI, GDP, jobs, yields, oil price, rate-hike odds)
- market_structure: index/sector/breadth/volatility/fund-flow numbers about the market itself
- cross_company_theme: one explicit theme spanning >= 2 named companies (list them all in tickers)
- corporate_event: M&A or deal talks, buyback, debt/equity raise, spin-off, lawsuit/regulatory action, management change, contract award
- geopolitics: war, sanctions, tariffs/trade policy, elections/politics as they bear on markets
- shock_risk: sudden adverse event (hack, outage, accident, bankruptcy, default, fraud)
- opinion: the writer's judgement, forecast or thesis, not a reported fact
- vendor_signal: a vendor's model score or ranked pick list (AI scores, "Strong Buy" lists, top-stock lists)
Rules:
- One fact per element; claim <= 200 chars, plain English, faithful to the email. Copy every number exactly as written; never compute, round or convert.
- tickers: US-listed tickers the fact is about. Resolve US-listed company names (Alphabet -> GOOGL, Meta -> META). No private or foreign-only companies, no index names.
- numbers: the numbers in the claim, verbatim with units ("+12%", "$578 B", "3.7%").
- checkable: true if our market/fundamental data could confirm or refute it.
- horizon: "past" for reported facts, an ISO date for a dated event, "1w"/"1m"/"3m"/"12m" for forecasts, else "none".
- Cover every company and every macro/market number the email reports. Skip ads, sponsor blocks, footers, subscription text.
- Lists, tables and calendars (earnings calendars, movers, watchlists, ratings lists): one element per group with ALL its tickers
  (e.g. "Report Tue Oct 27 before the open" + every ticker listed), never drop names to save space.
- Return [] only when the text has no market content at all (pure ad or boilerplate).
- At most ${MAX_FACTS} elements; most important first.
EMAIL:
`;

function parseJsonArray(text: string): unknown[] {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b <= a) return [];
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Pure guard step (tested): model output → facts that pass kind / number / ticker checks. */
export function guardFacts(raw: unknown[], body: string, universe: Set<string>): Omit<ExtractResult, "inputTokens" | "outputTokens"> {
  const bodyNums = new Set(numberTokens(body));
  const dropped = { numbers: 0, kind: 0, tickers: 0 };
  const facts: DeskFact[] = [];
  for (const r of raw.slice(0, MAX_FACTS)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const kind = String(o["kind"] ?? "") as DeskFactKind;
    if (!DESK_FACT_KINDS.includes(kind)) { dropped.kind++; continue; }
    const claim = String(o["claim"] ?? "").trim().slice(0, 300);
    if (!claim) continue;
    const numbers = Array.isArray(o["numbers"]) ? (o["numbers"] as unknown[]).map(String).slice(0, 12) : [];
    if ([...numberTokens(claim), ...numberTokens(numbers.join(" "))].some((n) => !bodyNums.has(n))) { dropped.numbers++; continue; }
    const tickers: string[] = [];
    for (const t of Array.isArray(o["tickers"]) ? (o["tickers"] as unknown[]) : []) {
      const u = String(t).toUpperCase().replace(/^\$/, "").trim();
      if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(u)) continue;
      if (universe.has(u) || new RegExp(`(^|[^A-Za-z])\\$?${u.replace(".", "\\.")}([^A-Za-z]|$)`).test(body)) tickers.push(u);
      else dropped.tickers++;
    }
    const horizon = o["horizon"] == null ? null : String(o["horizon"]).slice(0, 20);
    facts.push({ kind, tickers: [...new Set(tickers)], claim, numbers, checkable: o["checkable"] === true, horizon });
  }
  return { facts, dropped };
}

let universeCache: { at: number; set: Set<string> } | null = null;
export async function loadTickerUniverse(): Promise<Set<string>> {
  if (universeCache && Date.now() - universeCache.at < 6 * 3600_000) return universeCache.set;
  // fmp_fundamentals alone was 271 names on 11-02 (GLW, CTSH missing) → union of the fundamentals + calendar tables
  const r = await db.execute(sql`SELECT UPPER(ticker) AS t FROM fmp_fundamentals UNION SELECT UPPER(ticker) FROM source_fundamentals
    UNION SELECT UPPER(ticker) FROM earnings_calendar UNION SELECT UPPER(ticker) FROM edgar_fundamentals`);
  const set = new Set((r.rows as { t: string }[]).map((x) => x.t));
  universeCache = { at: Date.now(), set };
  return set;
}

const LIST_LABEL = /^[\s•·▪*-]*((?:pre|post)[- ]?(?:open|close|market)|before the (?:open|bell)|after the (?:close|bell)|(?:earnings|reporting)(?: today| tomorrow)?)\b[^:A-Z]{0,20}:?\s*(.*)$/i;
const DAY_LINE = /\b(mon|tues|wednes|thurs|fri)day\b/i;
const TICKER_TOKEN = /^[A-Z]{1,5}(\.[A-Z])?$/;

/** A line that is a symbol list: ≥ 90 % ticker-shaped tokens. Symbols written in the email are taken as-is (the universe
 *  only breaks ties for 1-letter tokens — "A", "I" — which must be in it). */
function listTickers(text: string, universe: Set<string>): string[] | null {
  const toks = text.split(/[,;]\s*|\s+/).map((t) => t.trim()).filter(Boolean);
  if (!toks.length) return null;
  const hits = toks.filter((t) => TICKER_TOKEN.test(t) && (t.length > 1 || universe.has(t)));
  return hits.length >= 0.9 * toks.length ? hits : null;
}

/** Earnings-timing ticker lists ("Pre-open: AAMI, ABEV, …", wrapped lines included) → one guidance_calendar fact each. */
export function listFacts(clean: string, universe: Set<string>): DeskFact[] {
  const out: DeskFact[] = [];
  const lines = clean.split("\n");
  let day = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length <= 60 && DAY_LINE.test(line)) day = line.replace(/[:•*]/g, "").trim();
    const m = LIST_LABEL.exec(line);
    if (!m) continue;
    const first = listTickers(m[2] ?? "", universe);
    if (!first) continue;
    const tickers = [...first];
    while (i + 1 < lines.length) {
      const more = listTickers(lines[i + 1]!.trim(), universe);
      if (!more || !more.length) break;
      tickers.push(...more);
      i++;
    }
    if (tickers.length < 2) continue;
    const label = m[1]!.replace(/\s+/g, " ");
    out.push({ kind: "guidance_calendar", tickers: [...new Set(tickers)], claim: `${day ? day + " · " : ""}${label}: these companies report`.slice(0, 200),
               numbers: [], checkable: true, horizon: "none", origin: "list" });
  }
  return out;
}

/** Line-aligned chunks of ≤ CHUNK_CHARS (a line longer than that is its own chunk). */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur && cur.length + line.length + 1 > size) { out.push(cur); cur = ""; }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) out.push(cur);
  return out;
}

export async function extractFacts(body: string, ticker = "_"): Promise<ExtractResult> {
  const clean = cleanForExtract(body);
  const universe = await loadTickerUniverse();
  const out: ExtractResult = { facts: [], dropped: { numbers: 0, kind: 0, tickers: 0 }, inputTokens: 0, outputTokens: 0 };
  const seen = new Set<string>();
  for (const part of chunkText(clean)) {
    const res = await callHaiku({
      prompt: PROMPT + part,
      maxTokens: 16_000,
      trigger: "desk_facts",
      surfaceType: "desk_facts",
      ticker,
      timeoutMs: 120_000,
    });
    // guard against the whole email: a number may sit in a neighbouring chunk's line
    const g = guardFacts(parseJsonArray(res.text), clean, universe);
    for (const f of g.facts) {
      const k = `${f.kind}|${f.claim.toLowerCase()}`;
      if (!seen.has(k)) { seen.add(k); out.facts.push(f); }
    }
    for (const k of ["numbers", "kind", "tickers"] as const) out.dropped[k] += g.dropped[k];
    out.inputTokens += res.inputTokens;
    out.outputTokens += res.outputTokens;
  }
  out.facts.push(...listFacts(clean, universe));
  return out;
}

interface PendingRow { id: number; source: string; kind: string; subject: string; received_at: string; body_plain: string }

/** Extract + store one email (replaces its earlier facts). */
export async function extractAndStore(row: PendingRow): Promise<number> {
  const sha = createHash("sha256").update(row.body_plain).digest("hex").slice(0, 16);
  const tier = sourceTier(row.source, row.kind, row.subject);
  try {
    const r = await extractFacts(row.body_plain);
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM desk_facts WHERE commentary_id = ${row.id}`);
      for (const f of r.facts) {
        await tx.execute(sql`INSERT INTO desk_facts (commentary_id, kind, tickers, claim, numbers, source_tier, checkable, horizon, received_at, extractor_version, origin)
          VALUES (${row.id}, ${f.kind}, ${JSON.stringify(f.tickers)}::jsonb, ${f.claim}, ${JSON.stringify(f.numbers)}::jsonb, ${tier},
                  ${f.checkable}, ${f.horizon}, ${row.received_at}, ${DESK_FACTS_VERSION}, ${f.origin ?? "model"})`);
      }
      await tx.execute(sql`INSERT INTO desk_fact_runs (commentary_id, extractor_version, body_sha, model, status, n_facts, dropped, input_tokens, output_tokens, error, ran_at)
        VALUES (${row.id}, ${DESK_FACTS_VERSION}, ${sha}, ${HAIKU_MODEL}, ${r.facts.length ? "ok" : "empty"}, ${r.facts.length},
                ${JSON.stringify(r.dropped)}::jsonb, ${r.inputTokens}, ${r.outputTokens}, NULL, now())
        ON CONFLICT (commentary_id) DO UPDATE SET extractor_version = EXCLUDED.extractor_version, body_sha = EXCLUDED.body_sha,
          model = EXCLUDED.model, status = EXCLUDED.status, n_facts = EXCLUDED.n_facts, dropped = EXCLUDED.dropped,
          input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens, error = NULL, ran_at = now()`);
    });
    return r.facts.length;
  } catch (err) {
    await db.execute(sql`INSERT INTO desk_fact_runs (commentary_id, extractor_version, body_sha, model, status, error)
      VALUES (${row.id}, ${DESK_FACTS_VERSION}, ${sha}, ${HAIKU_MODEL}, 'error', ${String((err as Error)?.message ?? err).slice(0, 500)})
      ON CONFLICT (commentary_id) DO UPDATE SET status = 'error', error = EXCLUDED.error, body_sha = EXCLUDED.body_sha, ran_at = now()`);
    throw err;
  }
}

/**
 * Background step after ingest (scheduler): emails from the last `days` with no run at this version / body, or an error
 * older than 1 h. Sequential, capped per run (rule 8c) — pages never wait on this.
 */
export async function extractPendingDeskFacts(opts?: { limit?: number; days?: number; ids?: number[] }): Promise<{ done: number; facts: number; errors: number }> {
  await ensureDeskFactsTables();
  const limit = opts?.limit ?? 20;
  const days = opts?.days ?? 3;
  const ids = opts?.ids ?? null;
  const r = await db.execute(sql`
    SELECT c.id, c.source, c.kind, c.subject, c.received_at::text AS received_at, c.body_plain
    FROM desk_commentaries c LEFT JOIN desk_fact_runs f ON f.commentary_id = c.id
    WHERE length(coalesce(c.body_plain, '')) > 200
      AND ${ids ? sql`c.id = ANY(${sql.raw(`ARRAY[${ids.map(Number).join(",")}]::int[]`)})` : sql`c.received_at > now() - make_interval(days => ${days}) AND COALESCE(c.noise_score, 0) < 50`}
      AND (f.commentary_id IS NULL OR f.extractor_version <> ${DESK_FACTS_VERSION}
           OR f.body_sha <> left(encode(sha256(convert_to(c.body_plain, 'UTF8')), 'hex'), 16)
           OR (f.status = 'error' AND f.ran_at < now() - interval '1 hour'))
    ORDER BY c.received_at DESC LIMIT ${limit}`);
  const out = { done: 0, facts: 0, errors: 0 };
  for (const row of r.rows as unknown as PendingRow[]) {
    try {
      out.facts += await extractAndStore(row);
      out.done++;
    } catch (err) {
      out.errors++;
      logger.warn({ err: String(err), id: row.id }, "desk-facts: extract failed");
    }
  }
  return out;
}
