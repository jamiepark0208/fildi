# S064 — Buy-zone puts: is selling a put at "a price I'd buy at" better than buying, or than bidding?
2026-10-20 · Claude · **Pre-registered bar FAIL; one real use (beats a limit order)** · `scripts/watchlist_sync/analysis/s064_buy_zone.py` ·
report `scripts/watchlist_sync/out/opt/S064_bs.md` (full) / `S064.md` (real-quote smoke) · plan `PLAN-buy-zone-puts.md` (v2 → v2.2)

## Question
Jamie 10-20: sell puts at strikes we'd be happy to get assigned at, on stocks we want to own. Does that beat (a) buying now,
(b) the same risk in stock, (c) a limit order at the same price?

## Data
- Entries: first lab Monday of each month, 2021-01 → 2026-07 (63 sessions of outcome needed). ~260 LSEG names (funds and TMO excluded: TMO has no LSEG history).
- Prices: `lseg_research.daily_history` (split-adjusted; traded strikes via `optlab.splits`). Option fills: real LSEG bid/ask on 4 names (smoke),
  Black-Scholes at IV30 × skew ratio for the full run (ratio = real fill ÷ BS, fitted on 152 smoke fills: 1.20 below 0.20Δ, 1.02 for 0.20–0.30, 0.98 above).
- Gate (point-in-time): IBES FY2/FY1 growth ≥ peer-group median, IBES breadth ≥ 0, StarMine combined alpha ≥ 50, StarMine predicted surprise > −2 %.
- Cash: 3-month T-bill (FRED DTB3, `out/opt/dtb3.csv`).

## Method
- Contract: monthly put nearest 37 DTE (28–50); strike = highest listed ≤ target with |Δ| 0.10–0.40, else no trade.
- Anchors (target price): A1 S·e^(−σ√T) · A2 max(52-week low, nearest top-4 60-day volume node below S) · A3 200-day MA if S above it · A5 StarMine PT mean × 0.70.
  (A4 fair value: no history before 2026-10 → not testable.)
- Outcome per $ of collateral, day 63: premium + T-bill on collateral while cash + (S63 − K)/K if assigned (held). Same entries for every comparator.
- Comparators: buy now; **same-risk stock** = buy-now scaled to the put's volatility (answers "is the put just a smaller position?"); limit order at K until expiry.
- Stats: Sharpe = mean/sd of 63-day excess return; t from a 3-month block bootstrap (monthly entries overlap); Holm over 4 anchors; halves H1 < 2022-10, H2 < 2024-07, holdout ≥ 2024-07.

## Result (gated names; full table incl. ungated in the report)
| anchor | slice | n | put mean | put Sharpe | buy-now Sharpe | same-risk stock mean / worst 10 % | put worst 10 % | limit Sharpe | ΔSharpe put − limit (t) |
|---|---|---|---|---|---|---|---|---|---|
| support (A2) | H1 | 456 | +2.5 % | 0.34 | 0.28 | +2.1 % / −9.0 % | −12.4 % | 0.22 | +0.12 (2.5) |
| support (A2) | H2 | 318 | +3.4 % | 0.28 | 0.33 | +3.7 % / −8.8 % | −14.0 % | 0.23 | +0.05 (1.3) |
| support (A2) | holdout | 416 | +4.6 % | 0.34 | 0.31 | +4.3 % / −9.9 % | −14.9 % | 0.24 | +0.10 (1.8) |
| 1σ vol (A1) | holdout | 481 | +3.0 % | 0.26 | 0.31 | +3.4 % / −7.0 % | −5.5 % | 0.26 | −0.00 (0.0) |
| 200d (A3) | holdout | 136 | +3.6 % | 0.23 | 0.39 | +5.3 % / −9.3 % | −14.8 % | 0.26 | −0.03 (−0.5) |
| PT×0.7 (A5) | holdout | 122 | +4.8 % | 0.39 | 0.37 | +4.7 % / −8.5 % | −13.2 % | 0.34 | +0.05 (0.4) |

Gate: gated − ungated Sharpe is positive in all 12 anchor × period cells for puts (support holdout +0.17, t 4.0), but just as large for buy-now
on the same entries (+0.15, t 2.7) → the gate picks better **stocks**; it is not a put-specific edge (same finding as S005).

## Verdict
- **vs buying now:** a tie on risk-adjusted return. Puts do carry less risk than a full position, but that is not a benefit of the put:
  a smaller stock position with the same volatility earns about the same and has a **smaller** worst decile (short puts bunch their losses).
- **vs a limit order at the same price:** the put is better on the support anchor in every period (+0.05 to +0.12 Sharpe; t 2.5 / 1.3 / 1.8).
  Small, consistent, not significant on the holdout alone. This is the real use: if you were going to bid for a stock at a level, sell the put there instead.
- The pre-registered bar (beat buy-now, t ≥ 2, Holm) fails for all four anchors.

## Decision
No third put lane. Phase 2 = a display line on Breakdown / Model List: "buyer at $X (support) — sell the put rather than placing a bid", gate shown
as context. Cursor builds via ASKS. No scoring change.

## Known weaknesses (reviewers: start here)
1. Full-run fills are modelled (BS × skew ratio from 152 fills on 4 names). The tie vs buy-now would need a ~±30 % premium error to flip; the put-vs-limit edge is ~1 % of collateral per trade, so a 20 % premium error could erase it. → real-quote confirmation of the support-anchor holdout (~1.5k LSEG requests) is the next check.
2. Strike walk differs: real mode walks listed strikes; BS mode takes the first ladder strike in the Δ band.
3. Ticker universe = today's survivors (S010: ≈ 0 bias at ≥ $3 / $300M).
4. v2.1 amendment (Δ band 0.15 → 0.10) and v2.2 (T-bill, scaled-stock comparator, block bootstrap) were made after seeing smoke / v2.0 output. The amendments fix mechanics, but they were not pre-registered.
5. Gate thresholds (alpha 50, surprise −2 %) were set in the plan without tuning; no sensitivity sweep yet.
6. Exit is at day 63 for all arms; a put seller would usually roll or re-sell. That's not modelled.

## Re-run
`cd research/lseg && .venv/bin/python ../../scripts/watchlist_sync/analysis/s064_buy_zone.py --bs` (0 LSEG requests, ~6 min) ·
smoke on real quotes: `… --tickers=CAVA,SHOP,MU,CRWV` (cached). Trade-level output: `out/opt/S064_bs.json` (local).
