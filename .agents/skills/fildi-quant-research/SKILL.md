---
name: fildi-quant-research
description: Run, judge and review FILDI backtests, studies and scenario analyses for the trader's real decisions (short puts, covered calls, Model List). Use before any "does X help trades?", "is X an edge?", study review, or scoring change — any agent.
---

# FILDI quant research — judgment + workflow (shared by Claude, Codex, Cursor, Muse)
The how-to lives in `research/studies/PLAYBOOK.md` (data tables, harnesses, checks) and `METHODS.md` (rules, each learned from a failed study).
This file is the **judgment layer** on top: what Jamie expects a good study to do. Read it once, then open those two as needed.

## 0. Before you start (≤ 2 min)
- `python3 scripts/oj.py studies "<question>"` + `research/studies/INDEX.md`: it may be answered; re-run its script instead of a new one.
- `scripts/watchlist_sync/FACTOR_MAP.md`: what live engines already score. Never propose a score that already exists under another name.
- Claim an ID in INDEX (`scripts/md_rows.py upsert …`, never a hand-rolled rewrite) with question, target, baseline, stop rule = **pre-registration**.

## 1. Judgment rules (Jamie's, with the incident that taught each)
1. **Test the use, not the direction.** Grade a feature on the decision it feeds (put pnl/breach, strike, sizing, avoid-list tail), not stock return. S042 said "≈ 0", but on puts it sorted +15.7 bp/wk (S045).
2. **Compare against what the trader would do instead.** Fair comparators: same entries, same risk. "Lower risk" is not a benefit if a *smaller position* gets it too: always add a **same-risk comparator** (scale the alternative to equal volatility). S064: puts looked like "half the tail", but a same-risk stock position had a *smaller* tail. The put's real win was vs a limit order.
3. **Count every cash flow:** fills (bid + 23 % of spread), T-bill on idle collateral (FRED DTB3), splits, fees if any. S064 v2.0 left out interest and understated puts ~1 %/trade.
4. **A FAIL is not the end.** Reverse-engineer the winners (what separated them before entry?) and confirm on an untouched holdout. Then report the use that *does* work, its size, and how sure we are. Jamie: "don't just say fail."
5. **Say the benefit plainly, and keep it apart from the bar.** Write: "+0.10 Sharpe vs a limit order, positive in all 3 periods, t 1.8: small, consistent, not yet proven". Don't write "not significant → FAIL". The pre-registered bar decides *adoption*; it doesn't erase a real small benefit.
6. **Challenge the premise, including Jamie's and your own plan's.** Test it against prior studies first ("half-right because S0xx"). S049-crash: our own plan said broad crashes were the losing case, and the data said the opposite.
7. **Volatility mechanics check** before trusting any option factor: hold IV fixed, run a placebo (shuffled feature ≈ 0). Most fake edges are IV in disguise.
8. **Smoke small first:** ~5 names, print trades, hand-check strikes / fills / splits / dates against reality before any full run (S064 smoke caught a Δ band that made one anchor untradeable, and a missing ticker).
9. **Overlap honestly:** monthly entries with 63-day holds overlap → block bootstrap (consecutive months); trades sharing an expiry week cluster (S016 ρ 0.6).
10. **Decide, don't ask.** Pick the next step from literature + tests and do it. Ask Jamie only about money, accounts or trades. Asking for a task = approval to finish it (AGENTS rule 7).
11. **Free / local first; state the cost.** No LLM for numeric decisions; OpenJev only per its tier (`.agents/openjev/REGISTRY.md`).

## 2. Efficient backtesting pattern (budget-aware)
1. Smoke on real quotes (LSEG/Polygon) for 4–5 names → keep every trade (JSON).
2. Calibrate a cheap model on those real fills (e.g. real ÷ Black-Scholes by |Δ| bucket = the skew ratio) → full universe on the model, 0 vendor requests.
3. Spend real-quote requests only to **confirm the deciding slice** (usually the holdout of the winning arm).
4. Vendor budgets: LSEG 10k requests/day shared with production syncs → cap research runs ≤ 3k (`REQ_CAP`) and shuffle ticker order so a capped run is a random sample. Polygon 5/min. Details: `fildi-market-data` skill.
5. Pure-Python bootstraps on 30k trades take minutes: fine; don't add numpy just for speed (no scipy in the venv).

## 3. Scenario analysis
Use the trader's real book (`optlab.*`; `scripts/watchlist_sync/pm_book.py` → `out/pm/book-latest.md`, `pm_alerts.py` MC VaR): breach odds from market IV are calibrated (S016), breaches correlate (ρ ≈ 0.6) → simulate one-factor shocks, report $ at risk and the worst cluster, not averages. Regime/crash questions: S027/S049-crash/S057 first.

## 4. Deliverable = review packet (what a reviewer gets)
- Script in `scripts/watchlist_sync/analysis/` (docstring: question, method, pass bar, run command) — numbers must reproduce from it, never from a chat query.
- Report `out/<area>/<study>.md` (versioned) + trade-level data local (JSON, gitignored).
- Card `research/studies/Sxxx-<slug>.md` (README template) incl. **Known weaknesses** — list what you'd attack first; amendments after seeing data are labelled.
- INDEX row via `scripts/md_rows.py`; plan/ASKS updated; result → product only through the PLAYBOOK §5 path.
- Reviewing someone else's study: `research/studies/REVIEW.md`.

## 5. Shared-file safety
Shared tables/docs (INDEX, ASKS, state) hold other agents' uncommitted work. Edit them with the Edit tool or `scripts/md_rows.py`.
Never `open(p, 'w')` in the same expression that reads `p` (Python truncates before reading, which was the 10-20 INDEX incident).
`.agents/hooks/shield.mjs` snapshots dirty files and flags truncation (`restore <path>` to undo).
