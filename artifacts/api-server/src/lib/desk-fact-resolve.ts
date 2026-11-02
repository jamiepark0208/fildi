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
import { fetchYahooAnalystActions } from "./yahoo-analyst-client.js";
import { ensureDeskFactsTables } from "./desk-facts.js";
import { logger } from "./logger.js";

export const RESOLVER_VERSION = 2;

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
  const dirBad = (c.action === "up" || c.action === "down") && dirs.length > 0 && !dirs.includes(c.action);
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
  if (!facts.length) return out;

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
  return out;
}
