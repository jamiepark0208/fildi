# Blended fair value: findings and design (2026-10-06)

Code: `artifacts/api-server/src/lib/fair-value.ts` (math) · `fair-value-snapshots.ts` (inputs, persistence, health) ·
params: `scorecard_params` lane `fair_value` (seed `fv-1.0.0` in `fair-value.ts`) · table: `fair_value_snapshots`.
Display only: feeds no score. Changing it into a score input needs the user's approval with a before/after.

## 1. What was wrong

The Breakdown "Fair Value" was `EPS × 2 × trailing 1-yr EPS growth %` (a Graham formula without its 8.5 base, rate
adjustment or long-term growth), with no caps. On 2026-10-06: only 9% of shown values within ±25% of price,
131 above 3× (LYFT $168,703 on a $15 stock, growth 12,332% off a tiny base), 46 negative values displayed, 215 blank.

## 2. How others do it (sources in the 2026-10-06 session report)

Simply Wall St (2-stage FCF DCF; excess returns for banks), Morningstar (analyst DCF + moat + uncertainty band),
LSEG StarMine IV (dividend discount on bias-corrected consensus), GuruFocus GF Value (historical multiples),
Alpha Spread (DCF + multiples average), FMP DCF API (available on our plan; $131 for AAPL at $333: too conservative to
use alone), revised Graham, Damodaran (growth = reinvestment × ROIC, terminal ≤ risk-free), wraquant (clamped growth,
guarded multi-method), reverse DCF (Mauboussin). Literature on combining: Yee 2004 (precision-weighted linear blend),
Liu–Nissim–Thomas 2002 (forward-earnings multiples most accurate; harmonic mean of peer P/E), forecast-combination puzzle
(equal weights beat estimated weights), Bhojraj–Lee 2002 (warranted multiples), Bradshaw–Brown–Huang (targets ~15%
optimistic in 2000–09).

## 3. Backtest (point-in-time, monthly 2020-02 → 2026-10)

Data: WRDS IBES statsum (FY1/FY2/LTG, restated to today's shares with Yahoo split history), LSEG daily closes,
`watchlist_sync.lab_outcomes` forward returns (peer-relative), LSEG price-target history (`pt_mean`, added to
`research/lseg/sync_starmine_history.py`). 81 tickers × 81 dates eligible (non-speculative, positive FY1).
DCF on FCF can't be backtested (no filed-date FCF history, lab item F2); StarMine IV has no API history.

Rank IC of log(fair/price) vs 6-month peer-relative return (t adjusted for overlap):

| method / blend | IC | t | median \|log V/P\| |
|---|---|---|---|
| peer forward P/E (median) | −0.072 | −1.9 | 0.41 |
| peer forward P/E (harmonic) | −0.089 | −2.3 | 0.46 |
| warranted P/E | −0.039 | −1.0 | 0.34 |
| Graham (forward) | −0.041 | −0.9 | 0.52 |
| Ohlson–Juettner | −0.090 | −1.7 | 0.60 |
| Lynch | −0.025 | −0.6 | 0.72 |
| blends: median / trimmed / winsor / MAD | −0.078 … −0.083 | ≈ −1.9 | 0.37 |
| blends: arithmetic / geometric / harmonic | −0.069 … −0.075 | ≈ −1.6 | 0.38–0.39 |
| learned: inverse-variance / IC-weighted / stacked OLS (out-of-sample) | −0.031 … −0.072 | −0.6 … −1.7 | 0.37–0.42 |

By year the sign is regime-driven, not a bug: 2022 (value rally) ≈ 0 to +0.08; 2024 and 2026 −0.10 to −0.24.

12-month convergence (slope of 12-m peer-relative log return on log(V/P); 1.0 = gap fully closes): every estimate
|slope| < 0.06. Analyst targets: implied +17.0% vs realized +14.8% → bias only 0.019 log in this bull sample; 48%
reached in 12 m; IC +0.04 (n.s.), the only positive one. Adding the de-biased target as an anchor (25/50/75%)
moves values toward price (0.36 → 0.18) without improving prediction.

**Conclusion (valuation level only):** no fair-value *gap* method or weighting predicted peer-relative returns 2020–26,
so accuracy-/IC-learned weights have nothing real to learn (and inverse variance rewards methods that hug the price).
Fair value is a valuation reference, not a timing signal. Choose the blend on robustness, stability and coverage.

**Correction / follow-up (factor study, `FACTOR_STUDY.md`, lab grader, 252 tickers, 71 tests):** patterns do exist —
in the *direction of change*, not in cheapness. Clearing the |t| ≥ 3 multiple-testing bar:
- forward EPS growth FY1→FY2: IC +0.094 (t 3.6) at 63 d, +0.108 (t 3.4) at 126 d, 77% hit, stable in both halves and
  selloffs, Q5−Q1 ≈ +4.4% / +6.1% peer-relative;
- 3-month change in consensus price target: IC +0.046 (t 3.1) / +0.052 (t 2.7); survives momentum (Fama-MacBeth t 2.4);
- trend (price vs MA200): IC +0.055 (t 3.1) at 126 d (reproduces the lab).
Level factors (forward earnings yield, Graham/OJ gaps, growth-adjusted value, analyst upside level) ≈ 0 or negative.
Hypothesis only (not significant alone): cheapness helps among top-half momentum stocks and hurts among bottom-half
(Graham gap +0.024 vs −0.128: value traps). PCA: PC1 (34%) = trend + target revisions + momentum, IC +0.065 (t 2.5);
PC2 (23%) = high beta/vol/growth vs earnings yield, IC +0.111 (t 2.2) — the 2020–26 regime paid for growth.
The old formula (EPS × 2 × growth) scored IC +0.034 (t 1.5, n.s.) only because it embeds growth.

## 4. Scenario analysis (live cross-section, 556 names)

Corrupt one method on 15% of names (×10, ×0.1, wild): p95 change in the blend (log points)

| blend | ×10 | ×0.1 | wild |
|---|---|---|---|
| arithmetic mean | 1.22 | 0.27 | 0.80 |
| geometric mean | 0.58 | 0.58 | 0.64 |
| median | 0.35 | 0.29 | 0.30 |
| trimmed | 0.36 | 0.32 | 0.30 |
| MAD filter | 0.53 | 0.56 | 0.45 |
| trimmed + analyst + StarMine | **0.25** | **0.20** | **0.20** |

Assumption shocks (mean |Δ blend| / share of names moving > 2%), trimmed+external: AAA ±100bp 0.02/43%,
risk-free ±100bp 0.006/15%, growth cap 15% 0.023/34%, ERP ±1pt 0.007/15%, terminal g ±0.5pt 0.007/15%;
median → harmonic peer statistic 0.069/56% (one parameter shifts every peer method, keep it fixed).

## 5. Design (fv-1.0.0)

- Voters routed by `peer_groups.scoring_mode`, honoring `metric_exclusions`:
  standard → peer forward P/E, warranted P/E, revised Graham (forward EPS, live FRED AAA), Ohlson–Juettner (FY1/FY2),
  10-y levered-FCF DCF at CAPM cost of equity (not WACC: FCF is after debt service), peer EV/EBITDA;
  financial/insurance → P/E family + excess returns (book + (ROE − k)·book/(k − g)); REIT → peer P/FFO;
  speculative / pre-revenue / crypto → none (analyst target stays a separate Breakdown line).
- External voters as equals: consensus target × e^(−bias), StarMine IV (no evidence for extra weight; revisit when
  snapshots accumulate).
- Blend: log space, trimmed mean (drop 1 high + 1 low at ≥ 4 votes, else median), ≥ 2 votes. Range = kept votes.
  Confidence from vote count + spread; `chinese` mode capped at low.
- Reverse DCF "price implies X%/yr FCF growth" for explanation.
- Input guards found while testing live: forward EPS must agree with USD trailing EPS (LSEG FY1 is local currency for
  BABA/HMC; vendor forward P/E is local for PDD); IBES used only when corroborated (ticker collisions, unadjusted
  splits); statement totals dropped when recomputed P/S disagrees with the vendor's by > 2× (HMC revenue in JPY).
  Net-income-based FX rescaling was tried and rejected (one-off charges at HPE/PVH/BP).

Result 2026-10-06: 436/568 valued (77%), 0 negative, median fair/price 1.08, 51% within ±25%, 5 above 3×.

## 6. Maintenance and verification

- Recomputed on every fund-score recompute (nightly, Maintain post-merge-scores 07:00, peer overrides, admin);
  manual: `pnpm exec tsx src/scripts/compute-fair-value.ts` (prints the health summary). ~1 s of DB + compute.
  Bursts coalesce (one run in flight + one queued); FRED AAA/10Y cached 6 h (`fair-value-yields` in the Cache Monitor).
- Daily check: Maintain's budget snapshot raises `fair_value_stale_*h` (> 36 h), `fair_value_extremes_*` (> 30; baseline 17),
  `fair_value_jumps_*` (> 10 moves > 30% with < 5% price move), `fair_value_coverage_drop_*` (> 10% fewer valued), `fair_value_missing`.
- Parameter changes: add a `challenger` row (lane `fair_value`) or pass an override, run
  `pnpm exec tsx src/scripts/compare-fair-value-params.ts` (before/after on identical inputs: coverage, distribution,
  extremes, confidence, biggest movers), then the user approves promotion.
- Monthly: `scripts/watchlist_sync/monthly.py` runs `research/fair_value/validate_snapshots.py` → `VALIDATION.md`
  (gap IC and 3-month-change IC vs next 63-day peer-relative return once ≥ 6 months mature; stability; coverage).
- Overlap check (`overlap_check.py`): forward EPS growth FY1→FY2 is uncorrelated with existing signals (|ρ| ≤ 0.17) and keeps
  t 3.2–3.6 after controlling for each → a genuine gap. 3-month price-target revision is ρ 0.77 with trend and drops to
  t 1.2 controlling for it → redundant with T3 trend; not proposed.
- Health summary per run: coverage, median fair/price, counts > 3× and < ⅓, null reasons, and day-over-day jumps > 30%
  with < 5% price move (usually a data error). Watch: `above3x`, `below1_3`, `suspectJumps`.
- Params change only via a challenger row in `scorecard_params` (lane `fair_value`) + user approval.
- Known limits: ADRs with currency-mixed vendor data mostly get "too few votes"; some tickers have no recent price.
- **Shipped 2026-10-06 (fund-1.1.0 + FV follow-ups):**
  - Forward EPS growth FY1→FY2 → fund expectations as optional `ibesFwdGrowth` (weight 2.5); `fund-1.0.0` retired for rollback.
    Before/after: rank corr 0.991, top-50 kept 48/50. Coverage bug fixed (optional = no shrink when IBES missing); one-off
    FY1 jump guard (GOOGL-class fake −27%). Lab grader tracks `ibes_fwd_growth` (IC +0.077 t 3.1).
  - Cyclicals (`isExtendedCyclical`): mid-cycle 2–3y EPS average tested in `cyclical_test.py` — **worse** accuracy, not shipped.
    Confidence capped at medium; badge explains why.
  - Value-trap flag (`hypothesis_tests.py` H1): cheap (fair/price ≥ 1.25) AND 12-1 momentum below median → badge + Explain.
    Lab Δ t 3.4 vs cheap+strong trend. Does not change scores or sizing.
  - Method disagreement (vote spread): still used for confidence bands only; not promoted to risk/sizing (lower later vol
    in the hypothesis check — not a risk measure).
  - Model List: `contract.fair_value` = strike vs fair (display); thesis header line.
- "Fair value 3-month change" on Breakdown (null until 85 days of snapshots), context only until validate_snapshots.py grades it.
- Validation loop: once ~6–12 months of snapshots exist, re-run §3 on our own snapshots (including DCF and StarMine)
  before any weight change or any use as a score input.
