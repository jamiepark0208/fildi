# Plan: conditional pattern discovery (2026-10-05). SUPERSEDED by `../../PLAN_next_session.md` after cost/benefit review; P3 (combination search) deferred

Problem: the lab grades each score across *all* markets and stocks. Real edges are conditional ("trend works except in broad
selloffs", "don't sell calls into 20-day strength"). We need labelled conditions, a systematic search over combinations, and
guards so a big search doesn't manufacture false patterns.

## A. Condition labels (stored once: watchlist_sync.lab_labels, per date and per ticker-date)
| family | labels | method / source |
|---|---|---|
| Market trend | up / sideways / down | (1) rules: SPY vs 200-day + 50-day slope (transparent baseline); (2) **statistical jump model** (`jumpmodels`, Nystrup / Shu / Mulvey; persistence penalty, scikit-learn API); (3) Gaussian HMM (`hmmlearn`) as a cross-check |
| Up/down variations | strong / mild / flat, grind vs V-shaped, early recovery (off lows, still below 200-day) | 63-day return buckets, drawdown-recovery phase (Daniel-Moskowitz rebound state) |
| Volatility | calm / normal / stressed; VRP rich / normal / panic | SPY IV and RV (have), VIX history (extend to 2020) |
| Breadth / dispersion | broad selloff, % above 50-day, cross-sectional dispersion | lab data (have) |
| Macro / credit | HY spread, NFCI, DXY, rates; the existing macro-cycle classifier replayed if its inputs reach 2020 | `macro-charts.json` series, FRED / LSEG to extend; reuse `regime-classifier.ts`, don't build a rival |
| Stock trend | own up / sideways / down, pullback in uptrend | own 200-day + slope (optional per-stock jump model) |
| Size | mega / large / mid / small | market-cap history (LSEG TR.CompanyMarketCap, small pull) |
| Type | sector, peer group, style bucket (growth / value / pre-revenue / financial), vol class, speculative (short interest) | registry + fund engine style + lab features |
| Event | earnings in window, post-earnings | have |

## B. Finding combinations (three methods, simplest first)
1. **Conditional report cards** (alphalens-style grouped IC): every score × every label, the same 6 criteria per bucket.
2. **Subgroup discovery** (`pysubgroup`): beam search over 2–3-condition conjunctions for the subgroups where an outcome
   (put breach, campaign return, call run-through, peer-relative return) or a score's IC differs most from the base rate.
3. **Interaction model** (LightGBM + SHAP interaction values): walk-forward model on labels + scores, used only to *rank which
   pairs interact* (e.g. trend × breadth), never as the live model.

## C. Guards (a large search finds noise unless constrained)
- Discover on 2020–2023, confirm on 2024–2026; patterns must hold in both.
- Count every trial; Benjamini-Hochberg on bucket tests; t ≥ 3 hurdle for new patterns (Harvey-Liu-Zhu); Deflated Sharpe for rule
  backtests (Bailey & López de Prado).
- Minimum support (≥ 12 months and ≥ 30 names per bucket); label-shuffle placebo; IV-mechanics check.
- An economic reason (literature or market mechanics) is required before a pattern is promoted.

## D. Where confirmed patterns go (no new scorecards)
- Market-level conditions → the **regime dial** (owner = R1 decision); stock-level conditions × scorecards → **Model List strategy rules**.
- Pattern registry (watchlist_sync.lab_patterns): conditions, effect, evidence, status candidate / confirmed / retired; the lab re-checks monthly.
- Your Robinhood history gets the same labels → which environments and combinations *your* trades worked in (descriptive; small n).

## Phases (stop for your review after each)
| phase | output | checkpoint |
|---|---|---|
| P1 labels | lab_labels + a 2020–26 regime timeline (rules vs jump model vs HMM) | does the timeline match what you remember (Covid, 2022 bear, Feb–Mar 2026)? |
| P2 conditional cards | every current score × every label | which scores are conditional rather than useless |
| P3 search | subgroup discovery + SHAP interactions, confirmed on 2024–26 | candidate pattern list with evidence and trial counts |
| P4 your trades | RH closes and campaigns by label | your best and worst environments |
| P5 wire-in | confirmed patterns → regime dial / Model List rules + monthly re-check | your approval per pattern |

Cost: research-only Python packages (jumpmodels, hmmlearn, pysubgroup, lightgbm, shap) in the watchlist venv; LSEG pulls for
market-cap history and sector ETFs, well inside the monthly guard; no live tables touched until P5.
