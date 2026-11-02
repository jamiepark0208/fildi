# Briefs dig + engine unification — plan (Claude, 2026-10-30)

Jamie 10-30: summarising the tradedash-brief emails is not the point; dig into what matters, verify subjective claims, grade sources.
Also: stop adding layers — unify engines. Skill: `.agents/skills/fildi-briefs-dig/SKILL.md`. Bugs: recurring-bugs B18 (population audit), B19 (second layer).

## What the last 4 days of briefs contained (158 emails, 10-26..30)
- **Volume (21 d):** 443 emails · Bloomberg 147 · StreetAccount 114 · WSJ 42 · LSEG 24 · TipRanks 23 · Danelfin 15 · ZeroHedge 15 · others.
- **Truncation:** 209 / 443 bodies (47 %) cut at 12,000 chars in `desk-commentary-parse.ts` (3 places); Drive JSON is whole but pruned at 21 d.
- **Dig-worthy this week (examples, all mapped in the skill § 2):** GOOGL 13 / GEV 5 / PLTR 3 new ratings (we hold 18 / 6 / 2 rows in
  analyst_events — OKLO, SKHY none); Search +12 % vs +15 % consensus; NOW −27 % on cRPO; FTNT −20 % on billings; input-cost inflation
  across 6 reporters; K-shaped consumer; MSFT $25 B+ debt sale + META ~$100 B raise + AVGO $63 B SPV (AI funding); MRVL–LITE talks;
  DASH–CART; GEV Trench + $20 B buyback; SK Hynix $75 B return; Binance $6.3 B hack; "Iran campaign after midterms"; Dec hike 76 %
  priced; CPI 3.7 % / GDP 3.4 %; week-ahead prints PLTR AMD ARM ON AAPL; Danelfin daily AI-score picks; Money Stuff podcast (audio only).
- **Book link:** every company above with a ticker (MRVL LITE SNDK INTC STX NXPI NOW FTNT COIN HOOD MSTR PLTR AMD ARM ON AAPL GEV DASH)
  is in the 10-30 put_recs candidate set. Today none of these emails reaches the put engine.

## Is Haiku enough?
For extraction, yes (typed facts per email, ~150/day). For the dig, no — the dig joins several tables, weighs a claim against a study
and writes a so-what; that is Sonnet (≤ 10/day) with code-checked numbers. Weekly synthesis = Opus. Model ids/usage through ONE
wrapper (engine E8 below) — today TS uses Haiku 4.5 and Python Haiku 5.5 / Sonnet 5.5 via raw HTTP.

## Progress
- **D0 (10-30):** ingest keeps whole bodies (≤ 200k) + raw Drive JSON → vendor_raw (601 files, 11 MB). Root cause was the Apps Script (12k plain / 20k HTML caps) → fixed in repo + `resaveDeskBriefs()`; Pushed via clasp; the 15-min trigger ran the resave itself (RESAVE_REV one-shot). **Bar met 10-30:** 0 / 580 bodies at 12,000 (was 267); 378 now > 12k, max 114,548.
- **E8 (10-30):** `artifacts/api-server/src/lib/llm-models.json` = one registry (ids, prices, thinking-off form) for haiku.ts / ai-pricing.ts / Python `llm.py` (official SDK, retries). TS Haiku 4.5 → 5.5 (A/B on a StreetAccount email: 1.4 s vs 2.4 s, $0.0003 vs $0.0020, no unsupported claim vs one). ai_usage_log now has the real model (Sonnet notes were logged as Haiku).
- **E2 (10-30, notes side):** `research/lseg/earnings_window.py` = one window; notes read lseg_research.earnings_moves (release date, amc/bmo). Old window wrong for every amc/bmo report; 66/66 agree ≤ 0.5 pp; 55 notes rewritten. Left: `analysis/option_derive.py` realized move → read the same table.
- **D1 (11-02): bar met.** `lib/desk-facts.ts` (Haiku 5.5, chunks ≤ 15k chars, code guards: kind list, every number must be in the email, tickers in universe or written; tier = code) + a code list pass for earnings-timing symbol lists (Haiku truncates 600-name calendars). Gold = 40 hand-labelled emails (`research/common/briefs-d1-eval/gold.json`, 1,752 tickers). v4: kind F1 0.868, ticker recall 0.969 (0.951 without the calendar email), precision 0.968, 0 invented numbers; $0.10 / 40 emails. Hand check 20 facts: numbers 20/20 on the right company, kind 17/20. Runs in the 15-min desk ingest job (≤ 20/run). `earnings_packet.briefs_for` now reads desk_facts (regex retired). Left: Live parsing (desk-link-dig / desk-dig-enrich) → D2 with E6; backfill older mail.
- **D2 part 1 (11-02):** `lib/desk-fact-resolve.ts` (code, no LLM) sets verdict agree / disagree / none / n-a + our_value per fact; it runs in the 15-min ingest after extraction. Analyst facts → analyst_events (firm + PT ±1 % + direction): 35 agree / 0 disagree / 81 none in 14 d, so the desk carries ~70 % of analyst actions our Yahoo/FMP feeds miss. Earnings-timing lists → earnings_calendar: 500 ticker cells agree, 34 disagree. Spot check: SMCI desk 11-03 is right; our calendar has 11-02 marked confirmed (B17 evidence). E6: Live dig reads desk_facts (body regex only as fallback): rich facts 4 → 196 on 29 emails. Report: `src/scripts/desk-facts-resolve.ts`. Left: resolvers for earnings_detail / macro / price claims / corporate events; desk analyst actions into the Breakdown analyst tape; calendar disagreements → calendar re-confirm.
- **B18 audit cost (10-30):** earnings audit full only when the parser hash changes (3.6 s), else this run's packets (18 ms) or skip (0 ms).

## Build order — briefs dig (each stage has a pass/fail bar; one stage per session)
| # | Stage | Builds on (Existing:) | Pass / fail |
|---|---|---|---|
| D0 | **Full text**: drop the 12k cut (store whole `body_plain` + raw JSON → vendor_raw); backfill the 21 days still on Drive | desk-commentary-parse.ts, ingest-desk-commentaries.ts | 0 bodies at exactly 12,000; 443 / 443 re-ingested |
| D1 | **One extractor** at ingest (TS, Haiku via the one LLM wrapper): email → `desk_facts` rows {kind (11 kinds), tickers, claim, numbers, source tier, checkable, horizon} | desk-link-dig.ts (analyst/PT kinds become one extractor kind), desk-dig-enrich.ts | hand-labelled 40-email set: kind F1 ≥ 0.8, ticker recall ≥ 0.9, 0 invented numbers; `briefs_for` (Python) + Live parsing read desk_facts |
| D2 | **Resolvers** (code, per kind): analyst → analyst_events (PT Δ, dispersion, up/down); earnings → earnings_packets; macro → macro_daily/FRED/Kalshi; price claims → prices_historical; calendar → earnings_calendar diff (feeds B17 as evidence); corporate event → corporate_events + book; theme → themes.json signposts | analyst-events.ts, earnings_packet.py, macro routes, put_recs exposure | each fact gets `our_value` + agree/disagree/none; agreement rate per kind reported; disagreements listed daily |
| D3 | **Dig** (Sonnet, top 10/day by exposure × materiality × novelty × tier): memo = claim · our data · so what · verdict · follow-up | earnings_notes numbers_ok checker, fildi-market-thesis claim tree | 10 memos/day, 0 untraceable numbers, each names the book/put/theme it moves; Jamie-rated useful ≥ 7/10 on a 2-week sample |
| D4 | **Outputs**: Live commentary (Muse first + dig memos), stock_notes (≤ 2/ticker/day), themes signposts, **put gates** (M&A / event / date-mismatch flags into put_recs news check), ASKS when a claim repeats ≥ 3 days | desk-daily-news.ts, stock_notes.py, put_recs news_flags (10-29), themes.json | put engine shows the email-sourced flag for MRVL-type events same day; no duplicate surfaces |
| D5 | **Claims + vendor ledger**: checkable claims and vendor picks (Danelfin, TipRanks lists) logged with horizon, graded automatically; per-source hit rate replaces hand `noise_score` | forecast_ledger.py (house view grading) | ≥ 30 graded claims/source before a tier changes; weekly source table |
| D6 | **Long-form**: Money Stuff podcast via RSS + local mlx-whisper ($0; needs install + ffmpeg) → transcript → D1; full Money Stuff / Bloomberg letters past 12k | D0, D1 | one episode transcribed end to end; facts extracted |
| D7 | **Weekly synthesis** (Opus): week's facts + StreetAccount bullish/bearish points → THESIS update + themes p changes with evidence | fildi-market-thesis skill, THESIS_*.md | one THESIS per week citing ≥ 10 graded/verified facts |

## Engines to unify (duplicate-layer audit 10-30, ranked by user impact)
| # | Job | Copies today | One home |
|---|---|---|---|
| E1 | next earnings date | 5+ SQL copies (build_plan, fit_model, structures, house_view, forecast_ledger) + technicals-db (calendar only) + research-lseg (LSEG only) | SQL function `next_earnings(ticker)` (calendar + LSEG, moved-date precedence), TS + Python call it |
| E2 | realized earnings move | sync_earnings_moves.window_move, earnings_notes._reaction, option_derive | lseg_research.earnings_moves; _reaction reads it (fallback only until the row exists) |
| E3 | daily bars | fetchAndStoreOHLCV + Python Polygon/LSEG side paths | one writer (TS); Python reads |
| E4 | street price target | 4 backfills in street-pt.ts + Python raw-table readers; FACTOR_MAP 'dup' | street-pt series with documented precedence |
| E5 | fair value headline | fair-value.ts blend vs dcf/engine.py vs FMP DCF | one headline, others labelled ranges (A283 3-chip design, awaiting Jamie) |
| E6 | events / news / briefs | desk-commentary + desk-link-dig + desk-dig-enrich + catalysts + event-bullets + put_recs news_flags + openjev_news + briefs_for | `desk_facts` + corporate_events behind one events service (= D1/D2) |
| E7 | SEC EDGAR | edgar-client.ts + 3 Python copies (financials, segments, earnings_packet re-fetches submissions twice) | Python `sec_client.py` (one UA, cached submissions via vendor_raw) |
| E8 | LLM calls + vendor gates | haiku.ts (Haiku 4.5) vs transcripts._summ_note raw HTTP (Haiku 5.5 / Sonnet 5.5); vendor_gate.py gap table hand-synced with VENDOR_POLICY; no Python circuit | one model registry + usage contract; gap table from one JSON; circuit ported |

Order: D0 → E8 (wrapper, needed by D1) → D1 → D2 (with E6) → D4 put gates → D3 → D5 → E1/E2 (wrong numbers today) → D6 → D7 → E3/E4/E7 → E5 (needs Jamie).
Heavy/mechanical stages (D0 backfill, E1 SQL migration, E3) → Cursor rows with these bars; Claude owns D1–D3 design, judges packets.

## Earnings packet lessons (10-30, applied)
Population audit `scripts/watchlist_sync/earnings_packet_audit.py` (0 / 75 invariant failures; revenue matches Finnhub 57 / 74; EPS
parsed 49 / 75; remaining EPS gaps = GAAP vs adjusted: ABT NOW T TENB, REIT FFO: PSA WELL). Missing lines fall back to transcript notes.
