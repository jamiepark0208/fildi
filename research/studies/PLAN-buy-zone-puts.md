# Plan: buy-zone puts — sell puts as paid limit orders on stocks we want to own — v2 (Claude 2026-10-20)
> Jamie 10-20: "a win isn't only expiring OTM… sell puts at strikes that could get assigned, if that's a price we'd want to buy at…
> set a target price at which we'd be a buyer… crashed stocks should be the best deep-OTM candidates… list should refresh daily or
> intraday… ignore my cash for now… this framework needs to be really good." v1 → red-team (§8) → **v2 (this)**. v3 after Phase 1.

## 0. What we already know (Research tab — build on it, don't redo)
| Study | Says | Use here |
|---|---|---|
| S005 | Put outcomes are predicted by **ownership** (StarMine alpha, trend, low idio vol), barely by premium; "selloff + rich VRP pays"; drawdown needs a thesis | supports the thesis: pick names first, strike second |
| S009 | **Cheapness vs fair value does not time returns**; forward EPS growth + PT revisions do; value-trap flag t 3.4 | a target price from fair value alone is NOT validated → test anchors (§3) |
| S015 | Jamie's 935 puts: picks fine (+0.36 %/trade), **assignment EV-neutral** | baseline the new lane must beat |
| S016 | Market-IV assignment odds are calibrated (18 % pred vs 21 % real); breaches cluster (ρ ≈ 0.6) | delta = honest P(assign); size for clusters |
| S025 | After a 2σ drop a bounce is **not** more likely than base rate (except SPY < 200d) | "crashed" ≠ "will bounce" |
| S049/S054 | Panic puts (2σ drop + IV30 > 48.7, 0.20Δ monthly) **pass**: +1.5 %/trade, 2025 confirmed; **lost in the broad Feb selloff** | crash lane exists; broad/sector crashes are its weak case |
| S058 | Falling-knife chart is not a sell reason | don't exclude crashed names for the chart |
| S059/S063 | Weekly put edge (IV/RV, vol-of-vol, put tech); weak credit pays more but fatter tail | income lane ranking; tail-aware sizing |
| S061 | Covered calls lose vs holding in bull tape | after assignment: hold, calls only far above cost |

## 1. Where I disagree with the ask (and what I'd do instead)
1. **"Crashed = best deep-OTM candidates."** Half right. Idiosyncratic crashes with IV30 > 48.7 pay (S049/S054). **Market- or sector-wide crashes are the losing case** (Feb 2026: −0.15 %/trade): breaches cluster (S016 ρ 0.6), so 10 semis puts in an AI selloff are one bet, not ten. → Crashed names get in (now true: daily pool, falling knife no longer a hold), but a sector-crash cap applies (≤ 2 per peer group, already the panic-lane rule) and the stance card says when the crash is broad.
2. **"Set a target price = fair value discount."** Our own S009 says that level doesn't predict. A buy target must be (a) a price level and (b) a **quality gate made of things that DO predict** (fwd EPS growth, PT/estimate revisions, StarMine alpha, trend). The level is tested, not assumed (§3).
3. **"Assignment is fine if it's a price we'd buy at."** Only if it beats the alternatives. A put is assigned exactly when the stock fell through the strike (adverse selection: S025 says no bounce edge), and if the stock rips you keep only the premium (you miss the upside a buy-now would get). Judge every buy-zone put by **63-day total return per $ of collateral** (premium + post-assignment stock return) vs (a) buying today, (b) a plain limit order at the strike, (c) the income lane. S015 says assignment was EV-neutral on your trades — the new lane must beat that.
4. **"Re-check the list many times intraday."** Re-verification already runs intraday on moves (`intraday.py`, regime checkpoints 15…330 min after open). A full re-rank intraday is noise (S014: option score ≈ IV) and burns the 100-rpm Schwab budget. What's missing and worth building: **intraday crash adds** (a name that drops ≥ 2σ intraday with IV30 > 48.7 enters the panic lane same day) and a **morning rebuild before the open** on the daily pool (done 10-20: the weekly-only pool was the bug).
5. **"Ignore cash."** Agreed for ranking — cash never decides whether an idea is good (done 10-20). Sizing still respects correlation (S016), not cash.

## 2. Three put lanes (one list, labelled)
| Lane | Goal | Contract | Names | Win = |
|---|---|---|---|---|
| **Income** (have) | premium, expire OTM | weekly ~0.20Δ, put edge Q4–Q5 | ownable, put risk < hold line | net pnl > 0 (S059) |
| **Crash** (have) | rich panic premium | monthly 0.20Δ day after a 2σ drop, IV30 > 48.7 | any non-distress-tail name, ≤ 2 per group | S049 pnl |
| **Buy zone** (new) | get paid to wait for an entry price | 30–45 DTE, strike = highest listed strike ≤ buy target, Δ 0.15–0.40 | **Own-quality only** (§3 gate) | 63-day total return per $ collateral > buy-now and > limit-order |

## 3. Buy target per stock (to be tested, not assumed)
Quality gate (must pass all; each already tested or testable on the lab panel): OWN ≥ 62 (green), forward EPS growth ≥ peer median, net estimate revisions ≥ 0 (no S060 down-revision flag), no predicted miss, StarMine combined alpha ≥ 50.
Candidate price anchors (one is chosen by Phase 1, or a blend if two pass):
- A1 **Volatility**: spot × exp(−1σ over the expiry) — "a normal bad month".
- A2 **Support**: max(52-week low, nearest high-volume node below spot) (S045 `sr_cushion`).
- A3 **Trend**: 200-day moving average when spot is above it.
- A4 **Value**: fair value (fv-1.1) × 0.85 — kept as a sanity cap (never buy above FV), not as a signal (S009).
- A5 **Analyst**: PT mean × 0.70 (PT level unvalidated; PT *revisions* are the signal).
Target = the chosen anchor, capped at A4. Shown per stock on Breakdown + Model List ("buyer at $X — today $Y, −Z %").

## 4. Verification (pre-registered; S064–S066 rows on the Research tab)
- **S064 buy-zone anchors** (lab panel 2020→2026, ~265 names, monthly entries, point-in-time): for gate-passing names, sell the put at each anchor's strike; outcome = 63-day total return per $ collateral (premium + assignment + hold to day 63; fills bid + 23 % spread). Compare vs buy-now and vs limit order at the same strike (no premium). **Pass:** best anchor beats buy-now on return/risk (Sharpe-like, week-clustered t ≥ 2, both halves), worst-decile no worse than buy-now. Holdout 2024-07→. Holm across 5 anchors.
- **S065 assignment-as-entry on your own book**: re-score S015's 935 puts + RH assignments with the 63-day metric; does gate-passing assignment beat non-gate assignment? Decides whether the gate is the edge.
- **S066 earnings block**: puts whose expiry spans earnings vs not, on S059 sims (S018: earnings IV ~1.5× overpriced). 89 names were blocked this week. **Pass:** net pnl ≥ non-earnings at breach ≤ +2 pp → block becomes warn + size smaller.
- **Re-audits** of prior studies this plan leans on: S049 split by **broad vs idiosyncratic crash** (SPY 20d < −5 % vs not) → tells us if this week's AI crash is the losing case; S015 under the new metric (S065).
- **Live:** each buy-zone pick → `forecast_ledger` (`buyzone_63d`, market-delta P(assign) vs our P); drift demote after 8 monthly cohorts.
- **Smoke test first**: 5 names (CAVA, SHOP, TMO, MU, CRWV), hand-check anchors, strikes, premiums, assignment paths before any full run.

## 5. Build (after S064 passes; Claude = studies + Python, Cursor = UI via ASKS)
1. `buy_targets.py` (nightly, after fit): gate + chosen anchor → `watchlist_sync.buy_targets (ticker, as_of, target, anchor, gate_pass, why)`.
2. `build_plan`: third put lane (buy zone) from the daily pool; one contract per ticker across lanes (best lane wins, labelled).
3. Intraday crash adds: `intraday.py` trigger "≥ 2σ intraday drop + IV30 > 48.7" → panic lane candidate → verify → publish.
4. UI (Cursor): Model List lane chip (Income / Crash / Buy zone), "buyer at $X" line, Breakdown buy-target card with anchor and gate.
5. Cash display: show collateral needed + account suggestion; never filter.

## 6. Phases and stop rules
| Phase | Work | Gate |
|---|---|---|
| 1 (now, ~1–2 sessions) | S064 smoke → full; S065; S066; S049 broad-vs-idio re-audit | S064 pass → Phase 2; fail → reverse-engineer winners (memory rule), else lane stays a display-only "buyer at" line |
| 2 | buy_targets.py + lane in build_plan + ledger | before/after on 5 trading days; ≤ 15 puts total; ≤ 2 per peer group |
| 3 | UI (Cursor) + intraday crash adds | p95 API < 200 ms; Schwab ≤ 100 rpm unchanged |
| 4 | 8 monthly cohorts live | drift rule decides keep/demote |

## 7. Not doing (and why)
- Long calls as "crash rebound" bets: S025/S057 say no bounce edge; VRP makes long options lose on average → Strategies tab only, untested badge.
- Re-ranking every hour: no evidence of value (S014), costs the Schwab budget; re-verify-on-move already exists.

## 8. Red-team log
**v1 → v2 (Claude 10-20):**
1. *Target from fair value* → S009 says no timing power → anchors tested; FV only as a cap.
2. *"Assignment is a win"* → adverse selection + missed upside → metric is 63-day total return vs buy-now and limit order, not "assigned at target".
3. *Crashed names = best* → S049 Feb loss, S016 clustering → sector cap + broad-crash flag; S049 re-audit.
4. *Intraday everything* → existing re-verify covers moves; only intraday crash adds are new.
5. *Look-ahead*: OWN/fit history is live-only → S064 rebuilds the gate from point-in-time lab features (IBES growth/revisions, StarMine alpha where history exists, trend), not today's OWN.
6. *Multiple testing*: 5 anchors → Holm; one pre-registered metric.
**Grok** may red-team v2 (standing A141) before Phase 2.
