/**
 * A267 — Polygon Form 4 / 8-K / related tickers + Schwab movers, expiration
 * chain, market hours, instruments. Typed tables via CREATE TABLE (schema/index.ts
 * was busy). Raw JSON also goes to vendor_raw. No score-weight changes.
 */
import { logger } from "./logger.js";
import { etDateKey, setSchwabMarketDay } from "./market-hours.js";
import { polygonApiKey, polygonFetch } from "./polygon-limiter.js";
import { rememberVendorPayload } from "./vendor-raw.js";
import { installSchwabUsageMeter } from "./schwab-usage-meter.js";
import { schwabGet, mapChainResponse, type SchwabChainResponse } from "./schwab-client.js";
import { schwabCredentialsConfigured } from "./schwab-auth.js";
import { noteBidQuality, withFreshDte, type OptionsChainResult } from "./options.js";
import { getShortInterest } from "./short-interest.js";
import {
  expiryWindowFromChain,
  feedDue,
  map8k,
  mapForm4,
  mapMovers,
  mapRelated,
  parseExpirationChain,
  parseSchwabHours,
  weeklyFromListing,
  ymdAdd,
  type EventRow,
  type InsiderRow,
  type ListedExpiry,
} from "./unused-feeds-parse.js";

const HOST = "https://api.polygon.io";
const INDEXES = [
  { id: "$SPX", label: "S&P" },
  { id: "$COMPX", label: "Nasdaq" },
  { id: "$DJI", label: "Dow" },
] as const;

let ensured: Promise<void> | null = null;

async function pool() {
  const { pool } = await import("@workspace/db");
  return pool;
}

export function ensureFeedTables(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      const db = await pool();
      await db.query(`
        CREATE TABLE IF NOT EXISTS insider_transactions (
          row_key text PRIMARY KEY,
          ticker text NOT NULL,
          filed date NOT NULL,
          insider text,
          role text,
          code text NOT NULL,
          sec_code text,
          shares double precision,
          price double precision,
          value double precision,
          security_type text,
          fetched_at timestamptz NOT NULL DEFAULT now()
        )`);
      await db.query(`CREATE INDEX IF NOT EXISTS insider_transactions_ticker_filed ON insider_transactions (ticker, filed DESC)`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS corporate_events (
          row_key text PRIMARY KEY,
          ticker text NOT NULL,
          filed date NOT NULL,
          category text,
          primary_category text,
          accession text,
          fetched_at timestamptz NOT NULL DEFAULT now()
        )`);
      await db.query(`CREATE INDEX IF NOT EXISTS corporate_events_ticker_filed ON corporate_events (ticker, filed DESC)`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS related_tickers (
          ticker text NOT NULL,
          related text NOT NULL,
          ord integer,
          as_of date NOT NULL,
          PRIMARY KEY (ticker, related)
        )`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS market_movers (
          index_id text NOT NULL,
          direction text NOT NULL,
          as_of date NOT NULL,
          symbol text NOT NULL,
          percent_change double precision,
          volume double precision,
          last_price double precision,
          rank integer,
          PRIMARY KEY (index_id, direction, as_of, symbol)
        )`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS option_expirations (
          ticker text NOT NULL,
          as_of date NOT NULL,
          expiry date NOT NULL,
          expiration_type text,
          standard boolean,
          PRIMARY KEY (ticker, as_of, expiry)
        )`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS schwab_market_hours (
          session_date date PRIMARY KEY,
          is_open boolean NOT NULL,
          open_min integer,
          close_min integer,
          fetched_at timestamptz NOT NULL DEFAULT now()
        )`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS feed_coverage (
          feed text NOT NULL,
          ticker text NOT NULL,
          as_of date NOT NULL,
          rows integer NOT NULL,
          PRIMARY KEY (feed, ticker, as_of)
        )`);
    })().catch((err) => {
      ensured = null;
      throw err;
    });
  }
  return ensured;
}

export class PolygonStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolygonStop";
  }
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function polygonJson(pathOrUrl: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const key = polygonApiKey();
  if (!key) throw new PolygonStop("polygon key missing");
  let url = pathOrUrl.startsWith("http") ? pathOrUrl : `${HOST}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  if (!/[?&]apiKey=/.test(url)) url += `${url.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(key)}`;
  // Gate lock timeout / fetch abort / network drop: one retry, then a clean stop (coverage is per name, next run resumes).
  // Was uncaught → whole run exit 1 (maintain unused_feeds_exit_1, 10-25/10-26).
  const fetchOnce = async (): Promise<Response> => {
    try {
      return await polygonFetch(url);
    } catch (err) {
      logger.warn({ path: pathOrUrl.split("?")[0], err: String(err) }, "unused-feeds: polygon transient — retry in 15s");
      await new Promise((r) => setTimeout(r, 15_000));
      try {
        return await polygonFetch(url);
      } catch (err2) {
        throw new PolygonStop(`polygon transient: ${String(err2)}`);
      }
    }
  };
  let res = await fetchOnce();
  for (let attempt = 0; attempt < 2 && res.status === 429; attempt++) {
    logger.warn({ path: pathOrUrl.split("?")[0] }, "unused-feeds: polygon 429 — pause 60s");
    await new Promise((r) => setTimeout(r, 60_000));
    res = await fetchOnce();
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (res.status === 429) throw new PolygonStop("polygon 429");
  return { status: res.status, body };
}

async function polygonPages(path: string, key: string, maxPages = 4): Promise<{ results: Record<string, unknown>[]; status: string; pages: number }> {
  let url: string | null = path;
  const results: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let pages = 0;
  while (url && pages < maxPages) {
    if (seen.has(url)) break;
    seen.add(url);
    const { status, body } = await polygonJson(url);
    pages++;
    await rememberVendorPayload({
      source: "polygon",
      endpoint: path.split("?")[0] ?? path,
      key: `${key}:p${pages}`,
      payload: body,
    }).catch((err) => logger.warn({ err: String(err) }, "vendor_raw: polygon store failed"));
    if (status === 403) return { results, status: "403", pages };
    if (status >= 400 || body?.status === "ERROR") return { results, status: String(body?.error ?? status), pages };
    const chunk = Array.isArray(body?.results) ? body.results as Record<string, unknown>[] : [];
    results.push(...chunk);
    const next = body?.next_url;
    url = typeof next === "string" && next.length > 0 ? next : null;
  }
  return { results, status: url ? "capped" : "ok", pages };
}

async function latestCoverage(feed: string, tickers: string[]): Promise<Map<string, { asOf: string; rows: number }>> {
  const db = await pool();
  const res = await db.query<{ ticker: string; as_of: string; rows: number }>(
    `SELECT DISTINCT ON (ticker) ticker, as_of::text AS as_of, rows
     FROM feed_coverage WHERE feed = $1 AND ticker = ANY($2::text[])
     ORDER BY ticker, as_of DESC`,
    [feed, tickers],
  );
  return new Map(res.rows.map((r) => [r.ticker, { asOf: r.as_of.slice(0, 10), rows: Number(r.rows) }]));
}

function dueTickers(tickers: string[], cov: Map<string, { asOf: string; rows: number }>, today: string, freshDays: number): string[] {
  return tickers.filter((t) => {
    const c = cov.get(t);
    return feedDue(c?.asOf ?? null, c?.rows ?? 0, today, freshDays);
  });
}

async function markCoverage(feed: string, ticker: string, today: string, rows: number): Promise<void> {
  const db = await pool();
  await db.query(
    `INSERT INTO feed_coverage (feed, ticker, as_of, rows) VALUES ($1, $2, $3::date, $4)
     ON CONFLICT (feed, ticker, as_of) DO UPDATE SET rows = EXCLUDED.rows`,
    [feed, ticker, today, rows],
  );
}

async function storedCounts(table: "insider_transactions" | "corporate_events", tickers: string[]): Promise<Map<string, { n: number; filed: string | null }>> {
  const db = await pool();
  const res = await db.query<{ ticker: string; n: string; filed: string | null }>(
    `SELECT ticker, COUNT(*)::text AS n, MAX(filed)::text AS filed FROM ${table} WHERE ticker = ANY($1::text[]) GROUP BY ticker`,
    [tickers],
  );
  return new Map(res.rows.map((r) => [r.ticker, { n: Number(r.n), filed: r.filed?.slice(0, 10) ?? null }]));
}

async function upsertInsiders(rows: InsiderRow[]): Promise<void> {
  const db = await pool();
  for (const r of rows) {
    await db.query(
      `INSERT INTO insider_transactions (row_key, ticker, filed, insider, role, code, sec_code, shares, price, value, security_type)
       VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (row_key) DO UPDATE SET value = EXCLUDED.value, shares = EXCLUDED.shares, price = EXCLUDED.price, fetched_at = now()`,
      [r.rowKey, r.ticker, r.filed, r.insider, r.role, r.code, r.secCode, r.shares, r.price, r.value, r.securityType],
    );
  }
}

async function upsertEvents(rows: EventRow[]): Promise<void> {
  const db = await pool();
  for (const r of rows) {
    await db.query(
      `INSERT INTO corporate_events (row_key, ticker, filed, category, primary_category, accession)
       VALUES ($1,$2,$3::date,$4,$5,$6)
       ON CONFLICT (row_key) DO UPDATE SET category = EXCLUDED.category, fetched_at = now()`,
      [r.rowKey, r.ticker, r.filed, r.category, r.primaryCategory, r.accession],
    );
  }
}

export async function modelListPool(): Promise<string[]> {
  const db = await pool();
  const res = await db.query<{ ticker: string }>(`
    SELECT DISTINCT UPPER(ticker) AS ticker FROM (
      SELECT ticker FROM model_recs WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM model_recs)
      UNION
      SELECT ticker FROM option_score_snapshots WHERE as_of = (SELECT MAX(as_of) FROM option_score_snapshots)
    ) s
    WHERE ticker IS NOT NULL AND ticker <> ''
    ORDER BY 1`);
  return res.rows.map((r) => r.ticker);
}

export async function universeTickers(): Promise<string[]> {
  const db = await pool();
  const res = await db.query<{ ticker: string }>(
    `SELECT DISTINCT UPPER(ticker) AS ticker FROM fmp_fundamentals WHERE ticker IS NOT NULL ORDER BY 1`,
  );
  return res.rows.map((r) => r.ticker);
}

async function pullFilings(
  feed: "form4" | "8k",
  tickers: string[],
  today: string,
): Promise<{ calls: number; rows: number; leak: boolean; status: string }> {
  const table = feed === "form4" ? "insider_transactions" : "corporate_events";
  const cov = await latestCoverage(feed, tickers);
  const due = dueTickers(tickers, cov, today, 1);
  const prior = await storedCounts(table, due.length ? due : ["__none__"]);
  let calls = 0;
  let rows = 0;
  const size = feed === "form4" ? 8 : 10;
  for (const ch of chunks(due, size)) {
    const known = ch.filter((t) => (prior.get(t)?.n ?? 0) > 0);
    const gte = known.length === ch.length
      ? ymdAdd(ch.map((t) => prior.get(t)?.filed ?? today).sort()[0]!, -1)
      : ymdAdd(today, -90);
    const path = feed === "form4"
      ? `/stocks/filings/vX/form-4?tickers.any_of=${ch.join(",")}&filing_date.gte=${gte}&limit=1000&sort=filing_date.asc`
      : `/stocks/filings/8-K/vX/disclosures?tickers.any_of=${ch.join(",")}&filing_date.gte=${gte}&limit=1000&sort=filing_date.asc`;
    const page = await polygonPages(path, ch[0] ?? feed);
    calls += page.pages;
    if (page.status === "403" || (page.status !== "ok" && page.status !== "capped")) {
      logger.warn({ feed, status: page.status, ticker: ch[0] }, "unused-feeds: polygon filings stopped");
      return { calls, rows, leak: false, status: page.status };
    }
    const want = new Set(ch);
    const mapped = feed === "form4" ? mapForm4(page.results, want) : map8k(page.results, want);
    if (mapped.leak) {
      logger.warn({ feed, ticker: ch[0], n: page.results.length }, "unused-feeds: ticker filter leak — not stored");
      return { calls, rows, leak: true, status: "leak" };
    }
    if (feed === "form4") await upsertInsiders(mapped.rows as InsiderRow[]);
    else await upsertEvents(mapped.rows as EventRow[]);
    rows += mapped.rows.length;
    for (const t of ch) {
      const got = mapped.rows.filter((r) => r.ticker === t).length;
      const keep = Math.max(got, prior.get(t)?.n ?? 0);
      await markCoverage(feed, t, today, keep);
    }
    logger.info({ feed, from: ch[0], n: mapped.rows.length, pages: page.pages, status: page.status }, "unused-feeds: filings");
  }
  return { calls, rows, leak: false, status: "ok" };
}

async function pullRelated(tickers: string[], today: string): Promise<{ calls: number; rows: number; status: string }> {
  const cov = await latestCoverage("related", tickers);
  const due = dueTickers(tickers, cov, today, 7);
  const db = await pool();
  let calls = 0;
  let rows = 0;
  for (const t of due) {
    const path = `/v1/related-companies/${encodeURIComponent(t)}`;
    const { status, body } = await polygonJson(path);
    calls++;
    await rememberVendorPayload({ source: "polygon", endpoint: "/v1/related-companies", key: t, payload: body }).catch(() => undefined);
    if (status === 429) throw new PolygonStop("polygon 429");
    if (status === 403) return { calls, rows, status: "403" };
    if (status >= 400) {
      await markCoverage("related", t, today, 0);
      continue;
    }
    const names = mapRelated(body).filter((r) => r !== t);
    await db.query(`DELETE FROM related_tickers WHERE ticker = $1`, [t]);
    for (let i = 0; i < names.length; i++) {
      await db.query(
        `INSERT INTO related_tickers (ticker, related, ord, as_of) VALUES ($1,$2,$3,$4::date)
         ON CONFLICT (ticker, related) DO UPDATE SET ord = EXCLUDED.ord, as_of = EXCLUDED.as_of`,
        [t, names[i], i, today],
      );
    }
    rows += names.length;
    await markCoverage("related", t, today, names.length);
    if (calls % 20 === 0) logger.info({ calls, ticker: t, n: names.length }, "unused-feeds: related");
  }
  return { calls, rows, status: "ok" };
}

async function pullShort(tickers: string[], today: string): Promise<{ calls: number; refreshed: number }> {
  const db = await pool();
  const res = await db.query<{ ticker: string; fetched: string | null }>(
    `SELECT UPPER(ticker) AS ticker, MAX(fetched_at)::text AS fetched
     FROM short_interest_history WHERE UPPER(ticker) = ANY($1::text[]) GROUP BY 1`,
    [tickers],
  );
  const have = new Map(res.rows.map((r) => [r.ticker, r.fetched?.slice(0, 10) ?? null]));
  const due = tickers.filter((t) => feedDue(have.get(t) ?? null, have.has(t) ? 1 : 0, today, 14));
  let refreshed = 0;
  for (const t of due) {
    await getShortInterest(t);
    refreshed++;
    if (refreshed % 10 === 0) logger.info({ refreshed, of: due.length, ticker: t }, "unused-feeds: short interest");
  }
  return { calls: refreshed * 2, refreshed };
}

async function pullHours(today: string): Promise<boolean> {
  installSchwabUsageMeter();
  if (!schwabCredentialsConfigured()) return false;
  const body = await schwabGet("/markets", { markets: "equity" })
    ?? await schwabGet("/markets/equity");
  const day = parseSchwabHours(body, today);
  if (!day) return false;
  const db = await pool();
  await db.query(
    `INSERT INTO schwab_market_hours (session_date, is_open, open_min, close_min)
     VALUES ($1::date, $2, $3, $4)
     ON CONFLICT (session_date) DO UPDATE SET is_open = EXCLUDED.is_open, open_min = EXCLUDED.open_min,
       close_min = EXCLUDED.close_min, fetched_at = now()`,
    [day.date, day.isOpen, day.openMin, day.closeMin],
  );
  setSchwabMarketDay(day);
  logger.info({ date: day.date, isOpen: day.isOpen }, "unused-feeds: schwab market hours");
  return true;
}

async function pullMovers(today: string): Promise<number> {
  if (!schwabCredentialsConfigured()) return 0;
  const db = await pool();
  const already = await db.query(`SELECT 1 FROM market_movers WHERE as_of = $1::date LIMIT 1`, [today]);
  if (already.rows.length > 0) return 0;
  let n = 0;
  for (const idx of INDEXES) {
    for (const direction of ["up", "down"] as const) {
      const sort = direction === "up" ? "PERCENT_CHANGE_UP" : "PERCENT_CHANGE_DOWN";
      const body = await schwabGet(`/movers/${encodeURIComponent(idx.id)}`, { sort, frequency: "0" });
      const rows = mapMovers(body).slice(0, 10);
      for (let rank = 0; rank < rows.length; rank++) {
        const r = rows[rank]!;
        await db.query(
          `INSERT INTO market_movers (index_id, direction, as_of, symbol, percent_change, volume, last_price, rank)
           VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8)
           ON CONFLICT (index_id, direction, as_of, symbol) DO UPDATE SET
             percent_change = EXCLUDED.percent_change, volume = EXCLUDED.volume, last_price = EXCLUDED.last_price, rank = EXCLUDED.rank`,
          [idx.id, direction, today, r.symbol, r.percent, r.volume, r.lastPrice, rank],
        );
        n++;
      }
    }
  }
  logger.info({ n }, "unused-feeds: index movers");
  return n;
}

async function loadExpirations(ticker: string, today: string): Promise<ListedExpiry[]> {
  const db = await pool();
  const cov = await db.query(
    `SELECT 1 FROM feed_coverage WHERE feed = 'expiration' AND ticker = $1 AND as_of = $2::date`,
    [ticker, today],
  );
  const cached = await db.query<{ expiry: string; expiration_type: string | null; standard: boolean | null }>(
    `SELECT expiry::text, expiration_type, standard FROM option_expirations WHERE ticker = $1 AND as_of = $2::date ORDER BY expiry`,
    [ticker, today],
  );
  if (cov.rows.length > 0 || cached.rows.length > 0) {
    return cached.rows.map((r) => ({
      expiry: r.expiry.slice(0, 10),
      expirationType: r.expiration_type,
      standard: r.standard,
    }));
  }
  if (!schwabCredentialsConfigured()) return [];
  const body = await schwabGet("/expirationchain", { symbol: ticker });
  if (body == null) return [];
  const listed = parseExpirationChain(body);
  await db.query(`DELETE FROM option_expirations WHERE ticker = $1 AND as_of = $2::date`, [ticker, today]);
  for (const e of listed) {
    await db.query(
      `INSERT INTO option_expirations (ticker, as_of, expiry, expiration_type, standard)
       VALUES ($1,$2::date,$3::date,$4,$5) ON CONFLICT DO NOTHING`,
      [ticker, today, e.expiry, e.expirationType, e.standard],
    );
  }
  await markCoverage("expiration", ticker, today, listed.length);
  return listed;
}

/** Option scan: listed Schwab expiries set the chain window. Logs `option scan: expirationchain`. */
export async function fetchScanChain(ticker: string): Promise<OptionsChainResult[] | null> {
  installSchwabUsageMeter();
  const key = ticker.trim().toUpperCase();
  const today = etDateKey();
  await ensureFeedTables();
  const listed = await loadExpirations(key, today);
  const window = expiryWindowFromChain(listed.map((e) => e.expiry), today, 45);
  logger.info(
    { ticker: key, n: listed.length, from: window?.from ?? null, to: window?.to ?? null },
    "option scan: expirationchain",
  );
  if (!window || !schwabCredentialsConfigured()) return null;
  const raw = await schwabGet<SchwabChainResponse>("/chains", {
    symbol: key,
    contractType: "ALL",
    includeUnderlyingQuote: "true",
    fromDate: window.from,
    toDate: window.to,
  });
  if (!raw) return null;
  const mapped = mapChainResponse(key, raw);
  if (!mapped?.length) return null;
  const by = new Map(listed.map((e) => [e.expiry, e]));
  const tagged = mapped.map((c) => {
    const listing = by.get(c.expiry);
    return {
      ...c,
      source: "schwab" as const,
      isWeekly: listing
        ? weeklyFromListing(listing.expirationType, listing.standard, c.isWeekly)
        : c.isWeekly,
    };
  });
  const fresh = withFreshDte(tagged);
  noteBidQuality("schwab", fresh);
  return fresh;
}

async function pullExpirations(tickers: string[], today: string): Promise<number> {
  const cov = await latestCoverage("expiration", tickers);
  const due = dueTickers(tickers, cov, today, 1);
  let n = 0;
  for (const t of due) {
    const listed = await loadExpirations(t, today);
    n += listed.length > 0 ? 1 : 0;
  }
  return n;
}

async function pullInstruments(tickers: string[], today: string): Promise<number> {
  if (!schwabCredentialsConfigured()) return 0;
  const cov = await latestCoverage("instruments", tickers);
  const due = dueTickers(tickers, cov, today, 7);
  let n = 0;
  for (const t of due) {
    const body = await schwabGet("/instruments", { symbol: t, projection: "fundamental" });
    if (body == null) continue;
    await markCoverage("instruments", t, today, 1);
    n++;
  }
  return n;
}

export async function peerAudit(): Promise<{ relatedRows: number; inPeerGroup: number }> {
  const db = await pool();
  const res = await db.query<{ related_rows: string; in_peer_group: string }>(`
    SELECT
      (SELECT count(*) FROM related_tickers)::text AS related_rows,
      (SELECT count(*) FROM related_tickers r
        WHERE EXISTS (
          SELECT 1 FROM peer_group_members a
          JOIN peer_group_members b ON a.group_id = b.group_id
          WHERE a.removed_at IS NULL AND b.removed_at IS NULL
            AND UPPER(a.ticker) = r.ticker AND UPPER(b.ticker) = r.related
        ))::text AS in_peer_group`);
  const row = res.rows[0];
  return { relatedRows: Number(row?.related_rows ?? 0), inPeerGroup: Number(row?.in_peer_group ?? 0) };
}

export interface FeedRunSummary {
  today: string;
  pool: number;
  scope: string;
  hours: boolean;
  movers: number;
  expirations: number;
  instruments: number;
  form4: { calls: number; rows: number; status: string };
  events: { calls: number; rows: number; status: string };
  related: { calls: number; rows: number; status: string };
  short: { refreshed: number };
  audit: { relatedRows: number; inPeerGroup: number };
  polygonStop: string | null;
  schwab: boolean;
}

export async function runUnusedFeeds(opts?: { scope?: "pool" | "universe"; limit?: number }): Promise<FeedRunSummary> {
  installSchwabUsageMeter();
  await ensureFeedTables();
  const today = etDateKey();
  const scope = opts?.scope ?? "pool";
  let tickers = scope === "universe" ? await universeTickers() : await modelListPool();
  if (opts?.limit && opts.limit > 0) tickers = tickers.slice(0, opts.limit);
  const summary: FeedRunSummary = {
    today,
    pool: tickers.length,
    scope,
    hours: false,
    movers: 0,
    expirations: 0,
    instruments: 0,
    form4: { calls: 0, rows: 0, status: "skip" },
    events: { calls: 0, rows: 0, status: "skip" },
    related: { calls: 0, rows: 0, status: "skip" },
    short: { refreshed: 0 },
    audit: { relatedRows: 0, inPeerGroup: 0 },
    polygonStop: null,
    schwab: schwabCredentialsConfigured(),
  };
  summary.hours = await pullHours(today);
  summary.movers = await pullMovers(today);
  summary.expirations = await pullExpirations(tickers, today);
  summary.instruments = await pullInstruments(tickers, today);
  if (!polygonApiKey()) {
    summary.polygonStop = "no key";
  } else {
    try {
      const form4 = await pullFilings("form4", tickers, today);
      summary.form4 = { calls: form4.calls, rows: form4.rows, status: form4.leak ? "leak" : form4.status };
      const events = await pullFilings("8k", tickers, today);
      summary.events = { calls: events.calls, rows: events.rows, status: events.leak ? "leak" : events.status };
      summary.related = await pullRelated(tickers, today);
      summary.short = await pullShort(tickers, today);
    } catch (err) {
      if (err instanceof PolygonStop) summary.polygonStop = err.message;
      else throw err;
    }
  }
  try {
    summary.audit = await peerAudit();
  } catch (err) {
    logger.warn({ err: String(err) }, "unused-feeds: peer audit failed");
  }
  logger.info(summary, "unused-feeds: run done");
  return summary;
}

export async function hydrateSchwabMarketHours(): Promise<void> {
  try {
    await ensureFeedTables();
    const today = etDateKey();
    const db = await pool();
    const res = await db.query<{ is_open: boolean; open_min: number | null; close_min: number | null }>(
      `SELECT is_open, open_min, close_min FROM schwab_market_hours WHERE session_date = $1::date`,
      [today],
    );
    const row = res.rows[0];
    if (!row) return;
    setSchwabMarketDay({
      date: today,
      isOpen: row.is_open,
      openMin: row.open_min ?? 570,
      closeMin: row.close_min ?? 960,
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "unused-feeds: market hours hydrate failed");
  }
}

export async function readInsiders(ticker: string): Promise<{
  netValue: number; buys: number; sells: number;
  rows: Array<{ filed: string; insider: string | null; role: string | null; code: string; shares: number | null; price: number | null; value: number | null }>;
}> {
  await ensureFeedTables();
  const today = etDateKey();
  const start = ymdAdd(today, -90);
  const db = await pool();
  const net = await db.query<{ code: string; n: string; value: string | null }>(
    `SELECT code, COUNT(*)::text AS n, SUM(value)::text AS value
     FROM insider_transactions
     WHERE ticker = $1 AND filed >= $2::date AND filed <= $3::date AND code IN ('buy','sell')
     GROUP BY code`,
    [ticker, start, today],
  );
  let netValue = 0;
  let buys = 0;
  let sells = 0;
  for (const r of net.rows) {
    const v = Number(r.value ?? 0);
    if (r.code === "buy") { buys = Number(r.n); netValue += v; }
    if (r.code === "sell") { sells = Number(r.n); netValue -= v; }
  }
  const rows = await db.query<{ filed: string; insider: string | null; role: string | null; code: string; shares: number | null; price: number | null; value: number | null }>(
    `SELECT filed::text, insider, role, code, shares, price, value
     FROM insider_transactions WHERE ticker = $1 AND filed >= $2::date
     ORDER BY filed DESC LIMIT 12`,
    [ticker, start],
  );
  return {
    netValue,
    buys,
    sells,
    rows: rows.rows.map((r) => ({ ...r, filed: r.filed.slice(0, 10) })),
  };
}

export async function readEvents(ticker: string): Promise<Array<{ filed: string; category: string | null; primaryCategory: string | null }>> {
  await ensureFeedTables();
  const db = await pool();
  const res = await db.query<{ filed: string; category: string | null; primary_category: string | null }>(
    `SELECT filed::text, category, primary_category FROM corporate_events
     WHERE ticker = $1 ORDER BY filed DESC LIMIT 15`,
    [ticker],
  );
  return res.rows.map((r) => ({ filed: r.filed.slice(0, 10), category: r.category, primaryCategory: r.primary_category }));
}

export async function readIndexMovers(): Promise<{
  asOf: string | null;
  marketOpen: boolean | null;
  indexes: Array<{ id: string; label: string; up: Array<{ symbol: string; percent: number | null; volume: number | null }>; down: Array<{ symbol: string; percent: number | null; volume: number | null }> }>;
}> {
  await ensureFeedTables();
  const db = await pool();
  const res = await db.query<{ index_id: string; direction: string; symbol: string; percent_change: number | null; volume: number | null; as_of: string }>(
    `SELECT index_id, direction, symbol, percent_change, volume, as_of::text
     FROM market_movers
     WHERE as_of = (SELECT MAX(as_of) FROM market_movers)
     ORDER BY index_id, direction, rank`,
  );
  const asOf = res.rows[0]?.as_of?.slice(0, 10) ?? null;
  const indexes = INDEXES.map((idx) => {
    const rows = res.rows.filter((r) => r.index_id === idx.id);
    const map = (direction: string) => rows.filter((r) => r.direction === direction).slice(0, 3).map((r) => ({
      symbol: r.symbol,
      percent: r.percent_change == null ? null : Number(r.percent_change),
      volume: r.volume == null ? null : Number(r.volume),
    }));
    return { id: idx.id, label: idx.label, up: map("up"), down: map("down") };
  });
  const hours = await db.query<{ is_open: boolean }>(
    `SELECT is_open FROM schwab_market_hours WHERE session_date = $1::date`,
    [etDateKey()],
  );
  return { asOf, marketOpen: hours.rows[0]?.is_open ?? null, indexes };
}

/** Symbols from the latest index-mover snapshot. Display / S097 input — not a score weight. */
export async function moverSymbols(): Promise<string[]> {
  const view = await readIndexMovers();
  const out = new Set<string>();
  for (const idx of view.indexes) {
    for (const r of [...idx.up, ...idx.down]) out.add(r.symbol);
  }
  return [...out];
}
