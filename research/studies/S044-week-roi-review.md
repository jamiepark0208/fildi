# S044 — Did a week of vibe-coding make the app smarter? (10-11 → 10-18)

**Author:** Claude (PM) · **Date:** 2026-10-18 · **Question (Jamie):** quantify the benefit/ROI of the past week; is the app truly smarter at fair value, scores, trade recs, and Model List organization?

**One-line answer:** more *correct* and more *honest*, not yet provably *smarter*. The tested edge is still IV/RV put selection (S003, 10-05). This week's biggest returns were data-bug fixes and studies that said "no"; the lowest were agent infrastructure.

## 1. Effort (git, 7 days)
- 486 commits (Claude 100 · Muse 76 · Cursor 47 · rest untagged).
- Lines added: app code +16.4k (trading/market features ~11.6k, agent/ops tooling ~4.9k) · pipelines/scripts +8.5k (OpenJev ~6.7k of scripts+registry) · studies +5.6k · agent coordination docs +10.0k (~500 ASKS file edits).
- Roughly **40 % of output was about running the agents** (coordination docs, OpenJev, Agents tab, NEEDS YOU inbox), not about markets.

## 2. Scorecard by goal

### Fair value
- Built: fv-1.1.0 coverage fix — 25 profitable large caps (ADBE, IBM, CRM, INTU…) had no FV; 436 → 464 valued, 0 changed. Assumptions trail + earnings-call inputs (display).
- Early live check (this review): 467 names, FV snapshot 10-06 → price 10-16. Cheapest quintile +2.85 % vs richest −3.92 %. Rank IC −0.21 (rich → worse); **−0.15 after controlling for volatility and 1-month momentum.**
- Caveat: one 12-day window inside a high-vol selloff (volatility alone IC −0.45). S009 (years of history) found cheapness gaps don't time returns. Treat as a hint.
- **Verdict:** coverage up, method honest; skill unproven. Re-test at 3 months (~2027-01-15), decide at 6.

### Scores (technical / options)
- Technical: S042/S042b — both scorers IC ≈ 0 → A155 kept one 6-comp scorer. Consistency win, not a smarts win.
- Options: S014 option_score adds ≈ 0 over IV; S033 HAR vol forecast FAIL; S041 S/R zones FAIL (mechanical, Claude review 10-18); S040 FAIL.
- **Verdict:** no new predictive edge. The week proved add-ons don't help — which kept ~8 noise features out of the scores (S019, S024, S027, S029, S033, S040, S041, S042b). That is real value: a worse app was avoided.

### Trade recommendations
- Reliability: Schwab token overwrite bug fixed — Model List had been stuck on the 10-06 run for a week. Daily re-pricing from option_chain_history (eligible puts 0 → 14).
- Honest risk: assignment odds calibrated (S016: 18 % predicted vs 21 % real, 926 puts). Live ledger: 22 put-OTM forecasts resolved, Brier 0.062 (all expired OTM — one week). VaR/stress on Book card (A161, BS-repriced).
- Habit checks: S015 picks +0.36 % of collateral/trade, no entry feature survives; S017 hold to expiry beats stops; S020 plain CSPs beat spreads/strangles.
- **Verdict:** recs now actually publish and risk numbers are calibrated; the edge is the same IV/RV harvest as before.

### Model List organization
- First live grade (one week, 2 runs → effectively ~258 names): Own 58 % beat, avg ≈ −0.1 % vs SPY. Avoid: 71 % fell, avg −9.2 % vs SPY, −3.6 % vs peers. **Own − Avoid ≈ +9 pp vs SPY, +4 pp vs peers.**
- Your holdings: 18 of 20 grades lagged, avg −12 % vs SPY. **5 of 9 holdings (REBN, GOSS, MP, ONDS, OPEN) were on the app's Avoid list.**
- Caveat: one week, high-vol selloff; Avoid ≈ high-vol names, so much of the spread is beta/vol, not insight.
- **Verdict:** most encouraging number of the week. Needs ≥ 8 weekly grades and a vol-matched comparison before calling it skill.

## 3. Data-correctness wins (highest ROI, under-appreciated)
- A114: half of past earnings_calendar rows were fiscal period ends, not report dates → every earnings-window rule (S003 blow-up flag, S018, S032) was reading wrong dates. Fixed.
- seed:peers override bug — 44 human peer fixes restored (cohorts feed FV).
- Schwab auth overwrite (above). A147 Yahoo 0 dividend yield (NEE, DUK, D, AEP). FV coverage hole (above).

## 4. Overhead (lowest ROI)
- OpenJev: good as an agent token saver (files 0.956, run 0.987) but every trading use failed (S037 next-day IC ≈ 0, S038 FV placebo copies the target, S040). Zero effect on picks.
- Coordination: 10k doc lines, review loop, 4 agents. Caught real bugs (A161 intrinsic understated losses, S041 mechanical PASS) — worth keeping, but the volume is high.

## 5. What "smarter" should mean — the scoreboard to watch (no new build needed; data already accrues)
1. Model List Own − Avoid, vol-matched, weekly (grades table).
2. FV cheapest − richest quintile, 1/3/6 months (fair_value_snapshots).
3. Put assignment Brier vs market-IV baseline (forecast_ledger; ≥ 20 resolved after 10-23).
4. IRA put P&L per $ collateral vs a naive benchmark (same-delta weekly puts on SPY/QQQ) — the real ROI question.

## 6. Recommendations
1. Slow feature/agent-tooling work ~4 weeks; let ledgers accrue (256 open forecasts, weekly grades, FV snapshots).
2. Re-run this review weekly from the four numbers above.
3. Your call (money): 5 holdings sit on the Avoid list.
4. Trim coordination volume: fewer simultaneous rows, studies only with a decision attached.
