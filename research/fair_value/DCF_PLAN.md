# Fildi DCF v2 — plan (Jamie 10-27)

Goal: an analyst-style DCF for the whole universe (~900 names) where every assumption is stated, sourced, refreshed on a
schedule, and has a sector default with stock-specific overrides. Uncertain assumptions are distributions, not points;
the output is a value range plus named scenarios, not one number tuned to the price. Replaces `dcfFcfe` in
`lib/fair-value.ts` (10-yr levered-FCF fade, growth cap 20 %, PLTR $15) and becomes the main fair value vote where it
applies (target version fv-2.0.0).

## 0. Deterministic vs probabilistic

| Deterministic (one right answer, rules) | Probabilistic (no single right answer → distribution) |
|---|---|
| EV → equity bridge (− debt − leases − minorities − preferred + cash) | Revenue growth path, year growth stabilises |
| Diluted shares (incl. options/RSUs), latest filing wins | Target operating margin and years to reach it |
| Tax: statutory 21 % + state as terminal marginal rate | Reinvestment (sales-to-capital) / terminal ROIC |
| Method routing by sector (bank → excess returns, REIT → FFO/NAV) | WACC: ERP, beta, target capital structure |
| Data-choice rules (freshest source, staleness limits) | Terminal growth |
| Accounting consistency (terminal g = reinvestment × ROIC) | Exit multiple (cross-check only) |

Output per stock: P10 / P50 / P90 fair value from Monte Carlo (correlated draws: growth ↔ margin, rates ↔ ERP), named
scenarios (bear / base / bull, rate +100 bp, recession), and a reverse DCF ("price sits at P78 of our distribution;
it implies 11 years of 30 % growth vs consensus 25 % for 3"). Confidence = band width + input quality, shown, not hidden.
~900 names × 2,000 draws vectorised = seconds nightly.

## A. Long-term capital market assumptions (market-wide, monthly)

| Input | Default | Source (continuous) | Notes |
|---|---|---|---|
| Risk-free | spot 10-y UST (cash flows) with Kroll-style floor | FRED DGS10 / DGS20 (have) | Kroll: spot 20-y when above its 3.5 % normalised rf |
| Equity risk premium | distribution centred on Damodaran implied ERP, Kroll 5.0 % as a check | Damodaran monthly implied ERP page, Kroll page (`fetch-page.sh`) | professor's ~5 % ≈ Kroll today; implied ERP moves with the market |
| Inflation / nominal growth | 10-y breakeven + real GDP trend | FRED T10YIE, GDPC1 | terminal g ≤ rf, ≤ nominal GDP |
| Credit spreads by rating | ICE BofA OAS by rating bucket | FRED BAMLC0A1CAAA…BAMLH0A3HYC | for cost of debt |
| Tax | 21 % + ~4 % state marginal | fixed, reviewed yearly | effective → marginal fade |

Stored in a `cma_monthly` table with source + date, so every DCF row records which CMA vintage it used.

## B. Company cost of capital

- **Beta:** blend of a regression beta (2-y weekly, Blume-adjusted) and a bottom-up beta (sector unlevered beta,
  Damodaran industry tables, re-levered at the target D/E). Regression beta alone is noisy for young names (PLTR).
- **Cost of debt:** (1) agency/issuer rating → rating spread (LSEG `issuer_rating`, 681 names, have);
  (2) market check: CDS (323 names, have) / bond yields (WRDS TRACE, not synced); (3) no rating → synthetic rating
  from interest coverage (Damodaran table; `interest_expense` 855 names, have); (4) sanity: interest ÷ debt.
- **Capital structure:** default = current market D/(D+E) moving toward the sector median over the forecast;
  "optimal structure" (min-WACC from the class survey method) is a scenario, not the default.
- WACC is a distribution (ERP, beta, spread draws) with a floor (e.g. ≥ rf + 2 %).

## C. Starting financials (freshest wins)

- Base = latest quarter TTM. Order: earnings press release (EDGAR 8-K Ex-99.1, same day as the call) →
  10-Q/10-K XBRL (`edgar_statement_history`, have) → vendor gold (`ticker_fundamentals`, refreshed 09-28…10-27).
- Bridge items: cash + investments, debt + leases, minorities, preferred, diluted shares (SBC dilution), NOLs.
- SBC is treated as a real expense (matters for software: PLTR, DDOG).
- A new filing or release triggers a revalue for that ticker (HOOD reported today → its revalue should run tonight).

## D. Forecast drivers (the hard part)

1. **Revenue growth, years 1–3:** consensus revenue FY1/FY2/FY3 (LSEG `revenue_mean_fy1` have; FY2/FY3 to add) +
   **management guidance** (IBES guidance on WRDS, not synced; transcripts/press releases → guidance extracted as
   number + verbatim quote + date; the LLM only extracts, never decides a number). Guidance vs consensus gap is shown.
2. **Years 4–N:** fade from year-3 growth to terminal g. **Stabilisation year N** is a distribution (5–15 y), set by
   the size of the growth gap and competitive intensity.
3. **Competitive intensity** (the class "qualitative survey", made quantitative): ROIC level and persistence
   (excess-return fade, Mauboussin), gross-margin level/stability, market-share trend, sector concentration.
   Scored per stock → shifts N and the target-margin distribution. Text reads (10-K competition section) are hints
   only and follow the OpenJev tier rules.
4. **Operating margin:** current → target margin (distribution between the company's own guidance/history and the
   sector's mature-peer P50–P75) over the convergence years.
5. **Reinvestment:** sales-to-capital (own 3–5-y history, sector median) → reinvestment = Δrevenue ÷ S/C.
   Consistency check: implied ROIC on new capital must be plausible vs sector.
6. **Tax:** effective → marginal by year 10.

## E. Terminal value

FCFF₍ₙ₊₁₎ / (WACC − g), g ≤ rf, with terminal reinvestment = g ÷ terminal ROIC (default ROIC = WACC + small moat
premium only for high competitive-advantage scores). Exit-multiple cross-check shown, not blended. Warning when the
terminal value is > 85 % of EV.

## F. Sector playbook and routing (research first, step 1)

Research per sector (Damodaran, McKinsey *Valuation*, Morningstar methodology, CFA curriculum, sell-side primers) →
main method, key ratios, normal growth/margin/reinvestment, what analysts override. Starting hypotheses:
banks/insurers = excess returns (ROTCE vs cost of equity, P/TBV); REITs = AFFO/FFO multiple + NAV; utilities =
regulated rate-base growth / DDM; E&P / miners = NAV or mid-cycle EV/EBITDA on strip prices; semis/memory and other
cyclicals = mid-cycle margins (MU/SNDK peak EPS); pre-profit software/fintech = FCFF DCF with target margin;
biotech pre-revenue = no model value (rNPV out of scope). Output: a practice-vs-ours table and a sector default file.

## G. Defaults and overrides

Order: market CMA → sector default → peer-group default → **ticker override** (existing `fv_assumptions` ledger:
reason, source, expiry = next earnings, superseded not edited). PLTR: growth path from guidance + consensus,
stabilisation 12–15 y, target margin from its own guidance, because sector defaults can't describe it. Overrides are
shown as overrides in the UI.

## H. Scenarios

Named scenarios and sliders run on the same engine: bear/base/bull (P10/P50/P90 driver sets), rate shock ±100 bp,
ERP ±1 %, recession (sector-specific growth/margin haircut), custom (user edits any assumption in the DCF tab →
instant recompute, not saved to the base value). Sensitivity grid WACC × g and growth × margin.

## I. Analyst targets (separate vote, cleaned)

Per-broker targets with dates (LSEG, after the Nov 1 budget reset; today only 196 names have per-broker data); drop
targets older than ~6 months or set before the last earnings; median; recency weight; weight shrinks with count
(n = 1 small, n ≥ 10 full); dispersion lowers confidence.

## J. DCF tab (Breakdown)

Assumptions table first (value, distribution, source, date, default vs override), then the build step by step:
revenue → EBIT → NOPAT → reinvestment → FCFF → PV → terminal → EV → equity → per share. Then the distribution chart,
scenarios, sensitivity grid, and the reverse-DCF line. Every number traceable.

## K. Validation (before fv-2.0.0)

1. Hand tests: PLTR, MU, CHTR, KO, JPM, O (+ HOOD after today's call) vs public analyst / Morningstar / Damodaran
   valuations, and Jamie's class method on one stock side by side.
2. Universe: coverage, share > 2× off price, day-to-day stability, stale-input count.
3. Backtest panel rebuild (`bt_load.py`): gap IC must not be worse than fv-1.2.0 (it won't time returns; S009).
4. Before/after table + Jamie sign-off on promotion.

## Phases (one at a time; Claude specs + judges, Cursor builds heavy fetch/UI)

| # | Phase | Owner | Depends on |
|---|---|---|---|
| 1 | Sector playbook research + CMA sources | Claude | — |
| 2 | CMA table + cost of capital (rating → spread, beta blend) prototype | Claude | 1 |
| 3 | Fresh financials: EDGAR 8-K earnings releases, revalue on filing | Cursor | — |
| 4 | Drivers: LSEG revenue FY2/FY3, IBES guidance sync, guidance extraction, competitive score | Claude spec, Cursor fetch | LSEG budget 11-01 |
| 5 | Engine: FCFF DCF + Monte Carlo + scenarios + reverse DCF, offline on 6 names → universe | Claude | 2, 4 |
| 6 | Sector routing + defaults + ticker overrides | Claude | 1, 5 |
| 7 | Street targets cleanup | Claude spec, Cursor fetch | LSEG budget |
| 8 | DCF tab UI | Cursor | 5 |
| 9 | Validation + promotion fv-2.0.0 | Claude, Jamie sign-off | all |

Engine home: Python (`scripts/watchlist_sync/dcf/`, numpy) nightly → `dcf_valuations` table; `fair-value.ts` reads it
as the DCF vote (one home per logic). Input: Jamie's class method (walkthrough or spreadsheet) for phase 5.
