# Review 1 — Model List sold-put recommendations

Codex · 2026-11-03 · Moves: ops / recommendation consistency.
History baseline: f0773a13 (October 26); 411 subsequent commits at initial HEAD df6175a1.
The shared tree advanced to 6b89d01c during this review. This is a bounded feature review, not an audit of every intervening diff.
Existing: A277 owns the single-engine work. No new task or second recommendation engine.

## Assessment

Substantial improvement: `put_recs_daily` now pins contract, rank, gates and score; Model List and Structures consume those decisions. The current published list passes the database-level agreement check. Recovery paths and the checker still need work before A277 can close.

Read-only database snapshot, November 3 afternoon Pacific:
- Latest engine: November 3, computed 08:58:03 Pacific; 454 evaluated names, 71 with contracts, 18 passing. Zero ranked picks missing a score (including JSON null, not just absent keys).
- Published run 94 / plan 65: all 18 sold puts match the engine's strike and expiry; none missing from the engine or gated by it.
- Existing strict checker: 58 surface rows vs 71 contracts, five warnings. All warnings concern plan candidates, not the published copy. ILMN/MRVL are strategy candidates; NTNX failed live verification. This does not prove a published-list defect.
- Two existing delta-floor tests pass. These establish fallback-band mechanics only, not profitability.

## Findings and fixes for Cursor; Claude reviews the quant integration

### 1. P1 — losing the engine silently changes the recommendation source

`artifacts/api-server/src/lib/option-score-snapshots.ts`, `readPutRecs` / `readLatestOptionRankings`:
the engine query catches every error as empty rows. An empty result falls through to legacy option-score picks. A healthy engine can recommend TEST 100p while the failure path returns TEST 105p with no engine metadata.

Reproduced offline against the actual reader function. The normal engine-overrides-snapshot control passes.

Fix: resolve puts from the engine first. Distinguish unavailable, successfully empty, and healthy. On failure use a previously saved **engine** run with explicit age/error metadata, or an explicit unavailable state; never substitute the legacy picker. Repair/alert the failed producer rather than merely hiding the symptom. Audit the browser's missing-snapshot `pickBestStrike` path too; do not change the call lane.

Acceptance: healthy, unavailable, legitimately empty and partial engine fixtures; an older legacy contract must never become an authoritative put recommendation. The chosen expiry/strike and gate state must agree across API and browser consumers.

### 2. P2 — a healthy engine disappears when legacy snapshots are absent

Same reader returns early on `!latest?.asOf` before reading the engine. The engine has its own contract and score, so this dependency is unnecessary.

Reproduction: one healthy engine row + zero legacy snapshot rows returns an empty board; the engine reader is never called.

Fix: engine-first put branch, legacy snapshots optional enrichment only. Preserve the existing call-reader behavior. Acceptance: the healthy put appears with its engine score with zero snapshots; missing optional enrichment is distinguishable from an empty recommendation set.

### 3. P2 — strict verification can report success without checking anything

`scripts/watchlist_sync/put_consistency.py`: all-empty sources return exit 0 and no meaningful summary. It also assumes Rankings/Live read the engine directly, so it misses findings 1–2. Its plan checks mix independent strategy candidates with engine candidates, producing warnings that do not describe the published list.

Fix: require source/run coverage and readable dates before claiming agreement. Scope plan checks by lane and separate draft diagnostics from published mismatches. Test the actual reader boundary with failure fixtures. Include a same-contract, same-run score check; key existence alone misses JSON null. Avoid making routine verification call vendors.

Acceptance: empty/unavailable/stale/mixed-run/null-score fixtures cannot produce a healthy result; a failed or distinct-lane draft candidate does not become a published mismatch; changing one published contract fails. The current 18 published rows remain an explicit passing control.

## Reproduction packet

- `2026-11-03-put-reader-probe.cjs` executes the current reader extracted with TypeScript's parser, using fake DB results. Two failure cases reproduced; one normal-path control passes. It does not boot the API or exercise the browser.
- `2026-11-03-put-checker-probe.py` runs the real strict-checker entrypoint against empty fixture tables. False success reproduced.
- Adjacent JSON receipts include production-source SHA256. Both probes intentionally exit nonzero until the desired behavior is fixed; they are review probes, not a replacement for application regression tests.
- Existing check: `scripts/watchlist_sync/.venv/bin/python -m unittest discover -s scripts/watchlist_sync -p put_band_floor_test.py` — 2/2 pass.
- Live read-only SQL compared the entire current published sold-put set, not selected tickers. No vendor requests, paid model calls, portfolio mutations or browser use.

## Decision value / next improvement

Keep the single-engine architecture. Highest immediate return is preventing source changes during failures and making verification trustworthy, before adding another score. Benefit hypothesis: fewer contradictory or silently substituted picks, with cheap deterministic tests; no financial-return claim.

The existing S088/S101 put benchmark already compares band policies with fixed-delta and public baselines. Its report is useful research evidence, but this review did not rerun or establish economic parity with every production gate, fill and publication rule in rules-1.8.0. Do not interpret today's consistency pass as proof of trading edge. Reuse its cached candidates for a later production-versus-benchmark parity check; only request vendor data if a specific uncovered case requires it.

## Sequential review queue

1. Sold-put Model List integration — this packet complete; A277 fixes remain with Cursor, review by Claude.
2. Stock DB and fundamental inputs — A318/A329 currency, ADR, EPS and full-population audit changes; trace into scores. Next review.
3. Scores/rankings and strategy economics — policy parity, grading, benchmark lineage and deployment gates.
4. Live risk, news and portfolio views — changed signal producers, freshness, grading and actionable outputs.
5. Operations/schedules — retries, dependencies, deadlines and rate budgets. Startup observed stale IV30 and four slow-route signals; not resolved or diagnosed in this feature review.
6. AI Ideas/Stage — reviews, ownership, usage visibility and workflow correctness.

Use one source-hashed packet per feature. Read its changed paths and existing tests; expand only on a concrete finding. Do not rerun unchanged expensive studies or spawn agents for discovery. No claimed percentage saving for this session.
