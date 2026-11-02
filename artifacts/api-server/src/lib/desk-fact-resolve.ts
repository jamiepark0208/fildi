/**
 * Briefs dig D2 — resolvers: check each desk_fact against our own data (code, no LLM).
 * verdict agree | disagree | none (we have nothing to check against) | n/a (fact not checkable by this resolver);
 * our_value = what our table says. Kinds without a resolver yet stay unresolved (verdict NULL).
 *   analyst_action            → analyst_events (Yahoo / FMP), firm + PT + direction
 *   guidance_calendar (lists) → earnings_calendar report_date (feeds B17 calendar fixes)
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { writeAnalystEvents } from "./analyst-events.js";
import { applyDeskEarningsDate, fetchLiveEarningsHistory, writeEarningsHistory } from "./earnings-history.js";
import { fetchYahooAnalystActions } from "./yahoo-analyst-client.js";
import { ensureDeskFactsTables } from "./desk-facts.js";
import { logger } from "./logger.js";

export const RESOLVER_VERSION = 3;

export type Verdict = "agree" | "disagree" | "none" | "n/a";
export interface Resolution { verdict: Verdict; ourValue: Record<string, unknown> }

export async function ensureResolveColumns(): Promise<void> {
  await ensureDeskFactsTables();
  await db.execute(sql`ALTER TABLE desk_facts ADD COLUMN IF NOT EXISTS verdict text`);
  await db.execute(sql`ALTER TABLE desk_facts ADD COLUMN IF NOT EXISTS our_value jsonb`);
  await db.execute(sql`ALTER TABLE desk_facts ADD COLUMN IF NOT EXISTS resolved_at timestamptz`);
  await db.execute(sql`ALTER TABLE desk_facts ADD COLUMN IF NOT EXISTS resolver_version integer`);
}

// ── analyst_action ───────────────────────────────────────────────────────────

export interface AnalystClaim { action: "up" | "down" | "init" | "pt" | "main" | null; pt: number | null; priorPt: number | null }

const money = (s: string | undefined) => (s ? Number(s.replace(/,/g, "")) : null);

/** Direction + new/old PT from a desk claim ("Cantor cut Alphabet target to $350 from $420, overweight."). */
export function parseAnalystClaim(claim: string): AnalystClaim {
  const c = claim.toLowerCase();
  const action = /upgrad/.test(c) ? "up" : /downgrad/.test(c) ? "down" : /initiat|\bstarts? coverage|\bbegins? coverage|\bresum/.test(c) ? "init"
    : /\b(rais|lift|boost|cut|lower|trim|reduc)\w*\b[^.;]{0,40}\b(target|pt)\b|\b(target|pt)\b[^.;]{0,20}\b(rais|lift|boost|cut|lower|trim|reduc)/.test(c) ? "pt"
    : /\b(maintain|reiterat|keeps?|affirm)/.test(c) ? "main" : null;
  const fromTo = /(?:target|pt)\b[^$;]{0,30}?to \$\s?([\d,]+(?:\.\d+)?)\s*(?:from|vs\.?) \$\s?([\d,]+(?:\.\d+)?)/i.exec(claim);
  if (fromTo) return { action, pt: money(fromTo[1]), priorPt: money(fromTo[2]) };
  // "target $480" vs "$181 target, 27% upside from $141.97" → take whichever dollar figure comes first.
  const after = /(?:target|\bpt)\b[^$;]{0,25}?\$\s?([\d,]+(?:\.\d+)?)/i.exec(claim);
  const before = /\$\s?([\d,]+(?:\.\d+)?)\s*(?:price )?(?:target|pt)\b/i.exec(claim);
  const at = (m: RegExpExecArray | null) => (m ? m.index + m[0].indexOf("$") : Infinity);
  const pt = at(before) < at(after) ? before : after;
  return { action, pt: money(pt?.[1]), priorPt: null };
}

const FIRM_GENERIC = new Set(["capital", "securities", "group", "research", "partners", "markets", "bank", "advisory", "financial",
  "company", "global", "equity", "investment", "isi", "the", "and", "co", "llc", "inc"]);
const FIRM_ALIAS: Record<string, string[]> = { "b of a securities": ["bofa", "bankofamerica", "bofasecurities"], citigroup: ["citi"],
  "jp morgan": ["jpmorgan"], "keefe, bruyette & woods": ["kbw"], keybanc: ["keybanc"] };

/** Does the claim name this firm? Distinctive words (≥ 4 chars, or an all-caps acronym) or a squashed alias. */
export function claimNamesFirm(claim: string, firm: string): boolean {
  const words = new Set(claim.toLowerCase().split(/[^a-z0-9&]+/).filter(Boolean));
  const squashed = claim.toLowerCase().replace(/[^a-z0-9]/g, "");
  const f = firm.toLowerCase();
  if ((FIRM_ALIAS[f] ?? []).some((a) => (a.length >= 6 ? squashed.includes(a) : words.has(a)))) return true;
  if (f.replace(/[^a-z0-9]/g, "").length >= 5 && squashed.includes(f.replace(/[^a-z0-9]/g, ""))) return true;
  const key = firm.split(/[\s,]+/).filter((w) => {
    const lw = w.toLowerCase().replace(/[^a-z0-9&]/g, "");
    return lw && !FIRM_GENERIC.has(lw) && (lw.length >= 4 || /^[A-Z]{2,4}$/.test(w));
  }).map((w) => w.toLowerCase().replace(/[^a-z0-9&]/g, ""));
  const hit = key.filter((k) => words.has(k));
  if (!hit.length) return false;
  if (hit.length > 1 || key.length === 1) return true;
  // One word of a multi-word firm: not when it is the tail of another name ("Kinder Morgan" ≠ Morgan Stanley).
  const m = new RegExp(`(\\S+)\\s+${hit[0]}\\b`, "i").exec(claim);
  return !(m && /^[A-Z][a-z]/.test(m[1]!));
}

interface EventRow { firm: string; action: string; to_grade: string | null; event_date: string; price_target: string | null; source: string }

const ROW_DIR: Record<string, AnalystClaim["action"]> = { up: "up", upgrade: "up", down: "down", downgrade: "down", init: "init", initiate: "init", initialise: "init" };

/** Compare one analyst claim with our analyst_events rows for that ticker (already windowed to the email's days). */
export function resolveAnalyst(claim: string, rows: EventRow[]): Resolution {
  if (/new analyst ratings? published|average (analyst )?(price )?target|consensus target/i.test(claim)) return { verdict: "n/a", ourValue: { why: "teaser/aggregate" } };
  const c = parseAnalystClaim(claim);
  const hits = rows.filter((r) => claimNamesFirm(claim, r.firm));
  if (!hits.length) return { verdict: "none", ourValue: { firmsInWindow: [...new Set(rows.map((r) => r.firm))].slice(0, 8), claimPt: c.pt } };
  const pts = hits.map((r) => (r.price_target != null ? Number(r.price_target) : null)).filter((n): n is number => n != null && n > 0);
  const ptOk = c.pt == null || !pts.length || pts.some((p) => Math.abs(p - c.pt!) / c.pt! <= 0.01);
  const dirs = hits.map((r) => ROW_DIR[r.action.toLowerCase()]).filter(Boolean);
  const opposite = c.action === "up" ? "down" : c.action === "down" ? "up" : null;
  const dirBad = opposite != null && dirs.includes(opposite) && !dirs.includes(c.action);
  const best = hits[0]!;
  return {
    verdict: ptOk && !dirBad ? "agree" : "disagree",
    ourValue: { firm: best.firm, action: best.action, toGrade: best.to_grade, date: best.event_date, pt: pts[0] ?? null, source: best.source,
                claimPt: c.pt, claimAction: c.action, ...(ptOk ? {} : { why: "pt" }), ...(dirBad ? { why: "direction" } : {}) },
  };
}

// ── guidance_calendar (earnings-timing lists) ───────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Report day a list fact is about: "Monday 2-Nov" / "Tuesday, Oct 27" / "Monday" (next one on/after receipt) / no day → receipt day. */
export function listFactDate(claim: string, receivedPtDate: string): string | null {
  const head = claim.split(" · ")[0]!.toLowerCase();
  const base = new Date(`${receivedPtDate}T12:00:00Z`);
  const md = /\b(\d{1,2})[- ]([a-z]{3})[a-z]*\b/.exec(head) ?? null;
  const dm = /\b([a-z]{3})[a-z]*\.? (\d{1,2})\b/.exec(head) ?? null;
  let mon = -1, day = 0;
  if (md && MONTHS.includes(md[2]!)) { mon = MONTHS.indexOf(md[2]!); day = Number(md[1]); }
  else if (dm && MONTHS.includes(dm[1]!)) { mon = MONTHS.indexOf(dm[1]!); day = Number(dm[2]); }
  if (mon >= 0) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), mon, day, 12));
    if (d.getTime() < base.getTime() - 200 * 864e5) d.setUTCFullYear(d.getUTCFullYear() + 1);
    return ymd(d);
  }
  if (!claim.includes(" · ")) {
    if (/tomorrow/i.test(claim)) { do base.setUTCDate(base.getUTCDate() + 1); while ([0, 6].includes(base.getUTCDay())); }
    return ymd(base);
  }
  const wd = WEEKDAYS.findIndex((w) => head.startsWith(w));
  if (wd < 0) return null;
  if (!/^[a-z]+day\W*$/.test(head)) return ymd(base); // prose caught as a day line ("Friday. $44B of 7-year notes…")
  while (base.getUTCDay() !== wd) base.setUTCDate(base.getUTCDate() + 1);
  return ymd(base);
}

/**
 * Per ticker: agree = we have that report date; disagree = we have a different upcoming date (on/after the email) within ±21 d;
 * pastOnly = our only nearby date is before the email (last print, or monthly reporter like PGR); none = nothing near.
 */
export function resolveCalendar(date: string, tickers: string[], ours: Map<string, string[]>, receivedPtDate: string): Resolution {
  const disagree: Array<{ t: string; ours: string[] }> = [];
  let agree = 0, none = 0, pastOnly = 0;
  const t0 = Date.parse(date);
  for (const t of tickers) {
    const near = (ours.get(t) ?? []).filter((d) => Math.abs(Date.parse(d) - t0) <= 21 * 864e5);
    if (near.includes(date)) agree++;
    else if (near.some((d) => d >= receivedPtDate)) disagree.push({ t, ours: near });
    else if (near.length) pastOnly++;
    else none++;
  }
  const verdict: Verdict = disagree.length ? "disagree" : agree ? "agree" : "none";
  return { verdict, ourValue: { date, agree, none, pastOnly, disagree: disagree.slice(0, 40), nDisagree: disagree.length } };
}

// ── runner ───────────────────────────────────────────────────────────────────

const YAHOO_PER_RUN = 10;
const YAHOO_DEADLINE_MS = 15_000;

interface FactRow { id: number; kind: string; tickers: string[]; claim: string; origin: string; received_at: string; pt_date: string }

/**
 * Background step after extraction (scheduler). Resolves facts with no verdict at this resolver version, plus analyst
 * 'none' verdicts once more after 12 h (vendors lag the desk by a day). Yahoo refresh capped + deadlined (rule 8c).
 */
export async function resolvePendingDeskFacts(opts?: { limit?: number; days?: number }): Promise<Record<Verdict, number>> {
  await ensureResolveColumns();
  const limit = opts?.limit ?? 200;
  const days = opts?.days ?? 7;
  const r = await db.execute(sql`
    SELECT id, kind, tickers, claim, origin, received_at::text AS received_at,
           (received_at AT TIME ZONE 'America/Los_Angeles')::date::text AS pt_date
    FROM desk_facts
    WHERE received_at > now() - make_interval(days => ${days})
      AND (kind = 'analyst_action' OR (kind = 'guidance_calendar' AND origin = 'list'))
      AND (resolved_at IS NULL OR resolver_version IS DISTINCT FROM ${RESOLVER_VERSION}
           OR (verdict = 'none' AND kind = 'analyst_action' AND resolved_at < now() - interval '12 hours'
               AND resolved_at < received_at + interval '3 days'))
    ORDER BY received_at DESC LIMIT ${limit}`);
  const facts = r.rows as unknown as FactRow[];
  const out: Record<Verdict, number> = { agree: 0, disagree: 0, none: 0, "n/a": 0 };
  const fix = () => fixCalendarDisagreements().catch((err) => logger.warn({ err: String(err) }, "desk-fact-resolve: calendar fix failed"));
  if (!facts.length) { await fix(); return out; }

  // Refresh Yahoo analyst history for names not fetched since the email (capped, sequential, deadlined).
  const analyst = facts.filter((f) => f.kind === "analyst_action");
  const want = [...new Set(analyst.flatMap((f) => f.tickers))];
  if (want.length) {
    const fresh = await db.execute(sql`SELECT ticker, max(fetched_at)::text AS at FROM analyst_events
      WHERE source = 'yahoo' AND ticker = ANY(${sql.raw(`ARRAY[${want.map((t) => `'${t.replace(/'/g, "")}'`).join(",")}]::text[]`)}) GROUP BY 1`);
    const at = new Map((fresh.rows as { ticker: string; at: string }[]).map((x) => [x.ticker, Date.parse(x.at)]));
    const stale = want.filter((t) => {
      const last = Math.max(...analyst.filter((f) => f.tickers.includes(t)).map((f) => Date.parse(f.received_at)));
      return !at.has(t) || at.get(t)! < last;
    }).slice(0, YAHOO_PER_RUN);
    for (const t of stale) {
      try {
        const raw = await Promise.race([fetchYahooAnalystActions(t), new Promise<unknown[]>((res) => setTimeout(() => res([]), YAHOO_DEADLINE_MS))]);
        if (raw.length) await writeAnalystEvents(t, raw);
      } catch (err) {
        logger.debug({ err: String(err), t }, "desk-fact-resolve: yahoo refresh failed");
      }
    }
  }

  for (const f of facts) {
    let res: Resolution;
    if (f.kind === "analyst_action") {
      if (f.tickers.length !== 1) res = { verdict: "n/a", ourValue: { why: f.tickers.length ? "multi-ticker" : "no ticker" } };
      else {
        const rows = (await db.execute(sql`SELECT firm, action, to_grade, event_date::text AS event_date, price_target::text AS price_target, source
          FROM analyst_events WHERE ticker = ${f.tickers[0]!}
            AND event_date BETWEEN ${f.pt_date}::date - 4 AND ${f.pt_date}::date + 1
          ORDER BY event_date DESC`)).rows as unknown as EventRow[];
        res = resolveAnalyst(f.claim, rows);
      }
    } else {
      const date = listFactDate(f.claim, f.pt_date);
      if (!date) res = { verdict: "n/a", ourValue: { why: "no date" } };
      else {
        const cal = await db.execute(sql`SELECT ticker, report_date::text AS d FROM earnings_calendar
          WHERE report_date BETWEEN ${date}::date - 21 AND ${date}::date + 21
            AND ticker = ANY(${sql.raw(`ARRAY[${f.tickers.map((t) => `'${t.replace(/'/g, "")}'`).join(",") || "''"}]::text[]`)})`);
        const ours = new Map<string, string[]>();
        for (const x of cal.rows as { ticker: string; d: string }[]) ours.set(x.ticker, [...(ours.get(x.ticker) ?? []), x.d]);
        res = resolveCalendar(date, f.tickers, ours, f.pt_date);
      }
    }
    out[res.verdict]++;
    await db.execute(sql`UPDATE desk_facts SET verdict = ${res.verdict}, our_value = ${JSON.stringify(res.ourValue)}::jsonb,
      resolved_at = now(), resolver_version = ${RESOLVER_VERSION} WHERE id = ${f.id}`);
  }
  await fix();
  return out;
}

const CAL_FIX_PER_RUN = 10;

/**
 * Upcoming dates where a tier-A desk list disagrees with earnings_calendar: re-fetch the vendor first (our row is often
 * just stale — 25 / 31 on 11-02); if the vendor still disagrees, the desk date wins (Finnhub estimates — AXON, PAA).
 * Skips tickers whose desk emails give different dates. Capped + deadlined (rule 8c).
 */
export async function fixCalendarDisagreements(): Promise<{ refetched: number; deskSet: number; ambiguous: number }> {
  const r = await db.execute(sql`SELECT d->>'t' AS t, f.our_value->>'date' AS desk, f.id, c.subject
    FROM desk_facts f JOIN desk_commentaries c ON c.id = f.commentary_id, jsonb_array_elements(f.our_value->'disagree') d
    WHERE f.kind = 'guidance_calendar' AND f.verdict = 'disagree' AND f.source_tier = 'A'
      AND (f.our_value->>'date')::date >= CURRENT_DATE AND f.received_at > now() - interval '14 days'`);
  const byT = new Map<string, { dates: Set<string>; ids: number[]; subject: string }>();
  for (const x of r.rows as { t: string; desk: string; id: number; subject: string }[]) {
    const e = byT.get(x.t) ?? { dates: new Set<string>(), ids: [], subject: x.subject };
    e.dates.add(x.desk); e.ids.push(x.id); byT.set(x.t, e);
  }
  const out = { refetched: 0, deskSet: 0, ambiguous: 0 };
  const touched = new Set<number>();
  // Every upcoming tier-A list date per ticker (agreeing facts too): a name listed 11-04 post-close AND 11-05 pre-open is ambiguous.
  const all = await db.execute(sql`SELECT d.t, f.our_value->>'date' AS desk FROM desk_facts f, jsonb_array_elements_text(f.tickers) d(t)
    WHERE f.kind = 'guidance_calendar' AND f.origin = 'list' AND f.source_tier = 'A' AND f.our_value ? 'date'
      AND (f.our_value->>'date')::date >= CURRENT_DATE AND f.received_at > now() - interval '14 days'`);
  for (const x of all.rows as { t: string; desk: string }[]) byT.get(x.t)?.dates.add(x.desk);
  const clear = [...byT].filter(([, e]) => e.dates.size === 1);
  out.ambiguous = byT.size - clear.length;
  for (const [t, e] of clear.slice(0, CAL_FIX_PER_RUN)) {
    const date = [...e.dates][0]!;
    const rows = await Promise.race([fetchLiveEarningsHistory(t, "desk-calendar-recheck"), new Promise<never[]>((res) => setTimeout(() => res([]), 20_000))]).catch(() => []);
    if (rows.length) await writeEarningsHistory(t, rows).catch(() => {});
    const now = await db.execute(sql`SELECT 1 FROM earnings_calendar WHERE ticker = ${t} AND report_date = ${date}::date`);
    if (now.rows.length) out.refetched++;
    else { await applyDeskEarningsDate(t, date, "desk:A", `${e.subject} (desk_facts ${e.ids[0]})`); out.deskSet++; }
    e.ids.forEach((id) => touched.add(id));
  }
  // Re-check the touched facts on the next pass.
  if (touched.size) await db.execute(sql`UPDATE desk_facts SET resolved_at = NULL WHERE id = ANY(${sql.raw(`ARRAY[${[...touched].join(",")}]::int[]`)})`);
  if (out.refetched || out.deskSet) logger.info(out, "desk-fact-resolve: calendar fixes");
  return out;
}

// ── desk analyst actions for Breakdown (the ones our feeds lack) ────────────

const GRADE = "(?:strong buy|strong sell|buy|sell|hold|overweight|underweight|equal[- ]weight|neutral|outperform|underperform|market perform|sector perform|peer perform|perform|in-line|accumulate|reduce|positive|negative)";
const VERB = "(?:upgrad|downgrad|initiat|rais|lower|cut|maintain|reiterat|lift|boost|trim|start|resum|reduc|keep|affirm)";

/** Broker named in a desk claim: "… at Barclays" or the capitalised words before the verb ("Cantor Fitzgerald (Deepak M.) raised …"). */
export function parseFirm(claim: string): string | null {
  const at = new RegExp(`\\b${VERB}\\w*\\b[^;]*?\\bat ([A-Z][\\w&.'-]*(?:\\s+(?:[A-Z&][\\w&.'-]*|of)){0,3})`).exec(claim);
  if (at) return at[1]!.replace(/\s+(?:on|after|with|to|from)$/i, "").trim();
  const lead = new RegExp(`^([A-Z][\\w&.'-]*(?:\\s+(?:[A-Z&][\\w&.'-]*|of)){0,3}?)\\s*(?:\\([^)]*\\)\\s*)?${VERB}`).exec(claim);
  return lead ? lead[1]!.trim() : null;
}

export interface DeskAnalystAction { firm: string; toGrade: string; fromGrade: string; action: string; date: string; priceTarget: number | null; source: "desk" }

/** Breakdown: desk analyst actions the checker found no feed row for (verdict none), last 365 d, one per firm per day. */
export async function readDeskAnalystActions(ticker: string): Promise<DeskAnalystAction[]> {
  const r = await db.execute(sql`SELECT claim, (received_at AT TIME ZONE 'America/Los_Angeles')::date::text AS d FROM desk_facts
    WHERE kind = 'analyst_action' AND verdict = 'none' AND tickers = ${JSON.stringify([ticker.toUpperCase()])}::jsonb
      AND received_at > now() - interval '365 days' ORDER BY received_at DESC LIMIT 60`).catch(() => ({ rows: [] as unknown[] }));
  // Oldest first so a call repeated in next-day emails keeps its first date (same firm + action + PT within 3 d).
  const seen = new Map<string, number>();
  const out: DeskAnalystAction[] = [];
  for (const x of (r.rows as { claim: string; d: string }[]).reverse()) {
    const firm = parseFirm(x.claim);
    if (!firm || /^(the|several|analysts?|wall street)$/i.test(firm)) continue;
    const c = parseAnalystClaim(x.claim);
    const k = `${firm.toLowerCase()}|${c.action}|${c.pt}`;
    const t = Date.parse(x.d);
    if (seen.has(k) && t - seen.get(k)! <= 3 * 864e5) continue;
    seen.set(k, t);
    const to = new RegExp(`\\b(?:to|at|as) (${GRADE})\\b`, "i").exec(x.claim)?.[1] ?? (/\b(maintain|reiterat|keeps?)\w*\s+(\w+(?:[- ]\w+)?)/i.exec(x.claim)?.[2] ?? "");
    const from = new RegExp(`\\bfrom (${GRADE})\\b`, "i").exec(x.claim)?.[1] ?? "";
    out.push({ firm, toGrade: to.replace(/\b\w/g, (m) => m.toUpperCase()), fromGrade: from.replace(/\b\w/g, (m) => m.toUpperCase()),
               action: c.action == null || c.action === "pt" ? "main" : c.action, date: x.d, priceTarget: c.pt, source: "desk" });
  }
  return out.reverse();
}
