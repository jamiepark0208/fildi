# Fildi DCF v2 — plan (Jamie 10-27, rev 2 after research) · ASKS A283

Goal (Jamie): an analyst-style DCF for the whole universe where every assumption is stated, sourced, refreshed, and
has a sector default plus stock-specific overrides; uncertain inputs are distributions; scenarios run on the same
engine. Judge = sensible, explainable, stable — **not** "match the price". Replaces `dcfFcfe` in `lib/fair-value.ts`
(levered-FCF fade, growth cap 20 %, cost of equity clamp 7–14 %: PLTR $15) and becomes the main vote where it applies.
Order: generic assumptions for every stock first (§A–§F), sector rules second (§G), stock overrides third (§H).

Evidence so far: `out/base_rates.md` (Compustat 1990–2025, `base_rates.py`), sources in §Sources.

## Rules in force (10-29, A283 it2 — the code is `scripts/watchlist_sync/dcf/engine.py`; this list wins over §D–§E and the 10-27 sections below)
- **Growth:** with consensus, years 1–3 = consensus per-year shrink to base rate by n/(n+3k); years 4–5 = the 5-y base rate (S113);
  without, years 2–5 = the residual compounding year 1 into the 5-y base-rate CAGR. Years 6–10 = 10-y base rate → terminal g.
- **Margin:** GAAP + consensus margin change × S115 pass-through; 75 % own / 25 % base rate by year 10; SBC fades per S114.
- **Reinvestment:** own 3-y sales-to-capital (net-capex fallback), 25 % sector anchor. Year-1 check vs own multi-year median
  reinvestment in the filings: > 15 pts = ⚠ flag, not unvalued (as a gate it unvalued 26 of 31 watchlist names; negative
  "actual" reinvestment from deferred revenue — PLTR −29 %, NOW −102 % — is not a target).
- **Unvalued (with reason):** banks/insurers/REITs; pre-revenue / deep loss; filings-vs-street mismatch; **peak-cycle margin**
  (positive year later fell ≥ 20 pp and margin now ≥ 15 pp and 1.5× own median, or ex-SBC margin +40 pp in one year →
  MU, SNDK, WDC, STX) until a mid-cycle rule exists.
- **Default pair = base.** Implied, LTCMA (7.5 %) and Kroll are named scenarios. **Superseded:** §D level-bucket margins,
  the R&D-capitalise + calibrate-to-1× steps, "narrow the width" (fix d, S113). No universe rerun; lab display only;
  fv-2.0.0 promotion needs Jamie's before/after sign-off. Return gap reported, never gated (S009, S116).

## 0. What is a rule and what is a distribution

| Deterministic (one right answer) | Probabilistic (no single right answer) | Why |
|---|---|---|
| EV → equity bridge (− debt − leases − minorities − preferred + cash), diluted shares | Revenue growth path and the year it stabilises | accounting identity vs forecast |
| Method routing (bank → excess returns, REIT → AFFO/NAV, DCF elsewhere) | Target operating margin and years to reach it | |
| Freshest-source rule and staleness limits | Reinvestment (sales-to-capital), terminal ROIC | |
| Internal consistency: terminal g ≤ rf; reinvestment = g ÷ ROIC; ERP paired with its rf | ERP, beta path, cost of debt, target capital structure | professionals disagree by 1–2 pts |
| Taxes by statute (21 % + state) | Probability of failure (distressed / unprofitable names) | |

Output per stock: P10 / P50 / P90 value (Monte Carlo, correlated draws: growth ↔ margin, rf ↔ ERP), named scenarios,
and the reverse DCF placed inside our distribution ("the price needs a P93 growth outcome"). Alternatives considered and
where they fit: APV instead of WACC when leverage changes a lot (CHTR, LBO-like); FCFE / excess returns for banks;
Morningstar-style weighted bull/base/bear when a distribution is overkill; real options (out of scope, noted).

## A. Risk-free rate and ERP (market-wide, monthly) — researched

- **The risk-free rate does not depend on the company.** It is set by the currency and the cash flows' horizon, so
  PLTR and KO use the same rf. A growth company's extra risk goes into beta / ERP and the failure probability, not rf.
- What professionals use (2026): Damodaran: 10-y UST (4.18 % on 1 Jan 2026) + **implied ERP 4.23 %** (S&P 500 IRR
  8.41 %), updated monthly; his "intrinsic" rf (inflation + real growth) was 5.10 %. Kroll: **ERP 5.0 %** (since
  June 2024) paired with the spot 20-y UST, normalised 3.5 % floor. McKinsey *Valuation*: 10-y (30-y for long cash flows)
  with ERP ~5 %. The pairing matters more than either number: an ERP is only valid with the rf it was estimated on.
  Long-duration growth stocks are most sensitive to this choice → it is a scenario axis, not a hidden constant.
- **Default:** 10-y spot + Damodaran implied ERP (consistent pair, market-based, monthly). **Scenarios:** Kroll pair
  (20-y + 5.0 %), historical ERP ~5 %, intrinsic rf, and term-structure discounting (year-t cash flow at the year-t
  Treasury zero rate). ERP distribution ≈ 4–5.5 %.
- Ours today: FRED rf + fixed 5 % ERP → expected market return ~9.2 % vs Damodaran 8.4 % / Kroll ~9.7 %: inside the
  range, but fixed and unpaired.

## B. Cost of capital over the company's life — researched

- **Cost of equity changes over time** (Damodaran, young/growth firms): high in the growth phase, moving to a mature
  company's level (beta → ~1, debt ratio → sector norm) as growth stabilises. One flat WACC for 10 years (ours) is
  wrong both ways: too low early for young names, too high late (PLTR clamped at 14 % forever).
- **Beta:** own 2-y weekly beta (Blume-adjusted) blended with the sector bottom-up beta (Damodaran industry tables,
  re-levered); the blend weight on own beta rises with history length and fit.
- **Cost of debt:** rating → rating spread (LSEG issuer_rating 681 names; FRED ICE BofA OAS by rating); CDS (323) as
  a market check; synthetic rating from interest coverage when unrated (`interest_expense` 855 names); TRACE yields
  later. Distribution, not point.
- **Capital structure:** current market weights moving toward the sector median; the "optimal structure" (min WACC)
  from Jamie's class survey method is a scenario.
- **Failure is not in the discount rate.** Value = going concern × (1 − p) + distress value × p. Base rate for
  companies with > $0.5B revenue: bankruptcy/liquidation within 5 y ≈ 0–2 % (`base_rates.md`); higher for
  unprofitable, levered or junk-rated names (rating default tables / Altman Z). Acquisition (13–24 % within 5 y) is not
  failure.

## C. Starting point (deterministic, freshest wins)

Latest quarter TTM: earnings press release (EDGAR 8-K Ex-99.1, same day) → 10-Q/10-K XBRL → vendor gold. Bridge items
(cash, debt + leases, minorities, preferred, diluted shares), SBC as a real expense. A new release revalues that
ticker the same night (HOOD reported 10-27).

## D. Growth — base rates + company information — first findings

Base rates (US, revenue ≥ $0.5B, forward CAGR P10/P50/P90): growth fades fast and the fade depends on size.
| start size | trailing 3-y growth | next 5-y | next 10-y | still > 15 %/y for 10 y |
|---|---|---|---|---|
| $2–10B | 10–20 % | −5 / 6 / 17 % | −3 / 5 / 13 % | 6 % |
| $2–10B | > 50 % | −12 / 11 / 33 % | −8 / 7 / 22 % | 24 % |
| $10–50B | 30–50 % | −11 / 6 / 26 % | −7 / 7 / 23 % | 22 % |
| > $50B | 10–20 % | −4 / 5 / 13 % | −4 / 3 / 9 % | 1 % |

Rule: years 1–3 = consensus revenue (+ management guidance where available), shrunk toward the base rate in proportion
to analyst count and dispersion (consensus long-term growth is optimistic: La Porta 1996; Chan, Karceski & Lakonishok
2003); years 4–10 follow the base-rate fade for the stock's size × growth bucket; the distribution comes from the
P10–P90. A company-quality score (ROIC persistence, margin stability, market-share trend) shifts it within the band.
Survivorship caveat: forward CAGRs exclude firms that left Compustat (shown separately).

## E. Margins and reinvestment — first findings

- Operating margins are sticky: tech starting 20–30 % → median 22 % five years later (P10–P90 7–33 %); > 30 % → 30 %.
  Fast growers improve more (tech 20–30 % & growing > 20 %: median 18 %… range 11–26 %). Target margin = distribution
  centred between the company's current/guided margin and its sector × margin-bucket base rate.
- ROIC fades only partly: tech > 40 % ROIC → median 28 % after 5 y; 15–25 % → 15 %. So terminal ROIC = WACC is too
  harsh for strong franchises; use the base-rate persistence by bucket (moat score moves it).
- Sales-to-capital (Δsales ÷ Δinvested capital, 5 y, median): tech 1.1, health 1.1, industrials 1.1, discretionary 1.5,
  staples 1.9, energy 0.6, comm 0.6, utilities 0.2 → reinvestment needed for the growth path; own history blended in.

## F. Terminal value

Gordon on FCFF₍ₙ₊₁₎ / (WACC_mature − g), g ≤ rf and ≤ nominal GDP, reinvestment = g ÷ terminal ROIC (from §E). Exit
multiple shown as a cross-check only. Warning when terminal value > 85 % of EV. Horizon N = 10 y default, 15 y when
the growth bucket says growth persists (> 30 % growers).

## G. Sector rules (after the generic engine works)

Research per sector (Damodaran, McKinsey, Morningstar, CFA, sell-side primers). Starting hypotheses: banks/insurers
excess returns (ROTCE vs cost of equity, P/TBV); REITs AFFO + NAV; utilities rate-base growth / DDM; E&P and miners NAV
or mid-cycle EV/EBITDA on strip prices; memory/semis and other cyclicals mid-cycle margins (MU/SNDK peak EPS); pre-profit
software/fintech DCF with target margin; pre-revenue biotech no model value.

## H. Stock overrides

Market → sector → peer group → ticker, via the existing `fv_assumptions` ledger (reason, source, expiry = next
earnings). PLTR-type names: growth path from guidance + consensus with a wider band; overrides are visible as overrides.

## I. Analyst targets (separate vote)

Per-broker targets with dates (LSEG after the Nov 1 budget reset; only 196 names have them today). Live targets only
(≤ ~6 months and after the last earnings), median, recency weight, weight grows with count, dispersion → confidence.

## J. DCF tab

Assumptions table first (value, distribution, source, date, default vs override), then revenue → EBIT → NOPAT →
reinvestment → FCFF → PV → terminal → EV → equity → per share; distribution chart; scenarios (rf/ERP pairs, rate ±100 bp,
recession, custom edits); sensitivity grids; reverse DCF (reuse A86's) placed inside our distribution.

## K. Validation

Hand tests (PLTR, MU, CHTR, KO, JPM, O, HOOD) vs public analyst / Morningstar / Damodaran valuations and Jamie's class
method side by side; universe coverage, > 2× share, stability, stale inputs; backtest panel rebuild (gap IC not worse
than fv-1.2.0); before/after + Jamie sign-off for fv-2.0.0.

## Phases

| # | Phase | Status |
|---|---|---|
| 1 | Generic research: rf/ERP, lifecycle cost of capital, failure, growth/margin/ROIC base rates | **done 10-27** (§A, §B, §D, §E) |
| 2 | CMA table (monthly: FRED rf/curve/breakevens/OAS/CBO potential GDP; Damodaran implied ERP; Kroll) | **done 10-27** `dcf/cma.py` → `cma_monthly` |
| 3 | Cost-of-capital module (beta blend, rating → spread, lifecycle path, failure p) | **prototype 10-27** in `dcf/engine.py` |
| 3b | Fresh TTM base from SEC XBRL (not in the original plan — found necessary) | **built 10-27** `dcf/financials.py` → `dcf_ttm_base` |
| 4 | Engine prototype: FCFF + base-rate distributions + scenarios + reverse DCF on hand-test names | **prototype 10-27** `dcf/engine.py` |
| 5 | Inputs: consensus revenue FY1–3 (LSEG), guidance (IBES guidance / 8-K releases), fresh filings | LSEG budget 11-01 |
| 6 | Universe run + sector rules + overrides | |
| 7 | Street targets cleanup | LSEG budget 11-01 |
| 8 | DCF tab UI (Cursor) · 9 validation + promotion | |

## Sources
Damodaran, *Data update 2026* (Musings on Markets, Jan 2026) and implied-ERP data · Damodaran, *Valuing young, start-up
and growth companies* (failure adjustment, changing discount rates) · Kroll recommended US ERP and risk-free (page
fetched 10-27) · McKinsey *Valuation* (rf / ERP practice) · Mauboussin & Callahan, *The Base Rate Book* (method) ·
La Porta (1996), Chan–Karceski–Lakonishok (2003) on growth persistence and LTG optimism.

## Findings 10-27 (phases 1–4 prototype)

1. **Our fundamentals are stale.** MU FY2026 (10-K filed 10-09): revenue $133B, operating income $99B; `ticker_fundamentals`
   still has $37B. PLTR TTM revenue $6.2B vs $4.5B stored. Periods are mixed (annual totals next to TTM ratios). SEC
   companyfacts gives a consistent TTM (`dcf/financials.py`), but some filers lag there (KO newest period 2026-04-03) and
   tags change (KO debt → `LongTermDebtAndCapitalLeaseObligations`) → staleness flag + tag fallbacks.
2. **Ratings field is mixed scales** (Moody's, S&P, short-term P-1/A1+, WR, "Discontinued"; PLTR "B" with no debt) →
   long-term scale only, else synthetic from interest coverage; net-cash profitable names get ~0 failure probability.
3. **Market assumptions today:** 10-y 5.00 %, 20-y 5.35 %, breakeven 2.35 %, CBO potential real growth 1.93 %.
   Expected market return: implied 8.7 % · base 9.25 % (ERP 3.7–5.1 %, mode 4.25 %) · normal 10.1 % · Kroll 10.35 %.
   fv-1.x used rf + 5 % ≈ 10 % (the "normal" end). Terminal growth centres on 4.3 % (≤ rf), not 2–3 %.
4. **[RETRACTED 10-27 night — made while the reinvestment bug was live; see § Assessment]** Base-rate growth vs prices: megacaps and fast growers are priced above what base rates support. Reverse DCF:
   MSFT needs P95 growth, KO P93, AAPL > P98 (41× NOPAT needs ~6.5 % cost of capital or record growth persistence);
   MU P42, CHTR P15 (priced for decline). This is what the DCF should show (percentile + implied growth), not hide.
5. **Margins: model the ratio, not the level.** Future/current margin medians: staples ≈ 1.0, tech 30–40 % → 0.87,
   40–50 % → 0.75. Level buckets dragged MSFT 47 % → 28 %.
6. **Next:** universe calibration run; SBC-heavy software (DDOG GAAP margin 0 %, FCF margin 23 %) and brokers (HOOD)
   need sector rules; MU's LTG is EPS growth off a boom (cyclical rule); consensus revenue FY2/FY3 (LSEG) instead of
   only FY1 + LTG.

## Calibration 10-27 (universe run, `dcf/engine.py --universe`, `research/fair_value/dcf_calibration.py`)

- SEC TTM base: 838/906 names. On 619 clean non-financial names our stored revenue is > 10 % off the latest TTM for 35 %,
  > 20 % for 15 % (80 of 94 big gaps = SEC higher → stale growth names: MU, BE, IONQ). SEC-side traps fixed/flagged:
  foreign filers in local currency (TM, XPEV), REIT/bank sub-line revenue tags (largest current tag now wins), one
  mis-scaled tag (BWXT leases $44.2B) → cross-check vs vendor, leases > revenue dropped, equity floored at 0.
- **Generic engine is biased low:** 688 names valued, median value/price 0.32 (≥ $10B caps: 0.43); price above our P90
  for 54 %. Lever test on 523 large caps (cumulative): g = rf 0.47 → implied ERP 0.55 → margins held 0.60 →
  terminal ROIC 25 % 0.78 → growth P75 0.92. Biggest single lever = terminal ROIC / reinvestment (0.43 → 0.56).
- Why: median large cap trades at 24× NOPAT; base-rate ROIC on *book* capital (10–15 %) makes the model reinvest
  35–45 % of NOPAT, which supports ~11–13×. Book capital omits intangible investment (R&D, brands, software), so measured
  ROIC and reinvestment needs are distorted for most of today's large caps.
- **Next (in order):** (1) capitalise R&D (Damodaran: amortise over 3–10 y by sector; XBRL ResearchAndDevelopmentExpense)
  and use each company's own sales-to-capital history blended with the sector base rate; (2) if the aggregate is still
  far below 1, add one documented market-consistency setting (excess-return fade) so the market as a whole values at
  ~1× under the implied pair, and keep the pure base-rate view as a scenario; (3) sector rules (utilities 0.04 and
  energy need rate-base / mid-cycle methods; brokers; cyclicals; SBC-heavy software); (4) LSEG FY2/FY3 revenue.

## Mechanics audit + LTCMA research 10-27 (watchlist-first; `dcf_watch.py`, `dcf_audit.py`)

**Long-term capital market assumptions (Jamie: "JPM says ~7.x %").** US large-cap 10–15-y forecasts: JPM 2027 LTCMA
(Oct 2026) 7.5 % (2026 ed. 6.7 % = 6.0 revenue + 3.0 buybacks + 1.7 dividends − 1.5 dilution − **2.0 valuation −
0.5 margins**); Northern Trust 6.8 %; 14-house median ~6.3 %; Vanguard 4.2–6.2 %; Research Affiliates 3.1 %; BlackRock
9.0 % (aggregator, unverified). These are *expected returns from today's prices* and include multiple compression; JPM ex
valuation/margin drag ≈ 9.2 %, which is where Damodaran (8.7–9.0 % implied) and Kroll (10.35 %) sit. So: discounting at
~7.5 % treats today's market multiples as fair (market-consistent); ~9–10 % assumes they revert. Both are shown:
`cma.py` pair `ltcma` (rf + (7.5 % − rf)) next to implied / base / normal / kroll; houses listed with sources.

**Mechanics bug found: reinvestment.** Year-1 reinvestment (share of NOPAT) model vs filings: AAPL 80 % vs 1 %,
NVDA 85 % vs 28 %, NFLX 75 % vs 11 %, PLTR 111 % vs −1 %. Cause: one sector sales-to-capital (Compustat ~1.1) for every
company. Working capital (AR, AP, deferred revenue, accruals), D&A and capex are inside operating cash flow; the model
folds them into reinvestment = Δrevenue ÷ sales-to-capital, so that ratio must be the company's own. Fix: own
sales-to-capital from 3 fiscal years + TTM (median reinvestment rate; < 15 % = asset-light), 75/25 blend with the sector;
terminal return on new capital = geometric mean of base-rate ROIC fade and own RONIC (≥ WACC, ≤ 60 %). After the fix:
AAPL 11 % vs 1 %, MSFT 56 vs 54, GOOGL 82 vs 80, AMZN 129 vs 139, NVDA 32 vs 28, NFLX 11 vs 11. Also added: mid-year
discounting, long-term investments in the equity bridge (AAPL $84B), 10-K-only fiscal history (AMZN 10-Q TTM lines).
EV → equity bridge, Gordon terminal value and discounting checked by hand on the audit output.

**10 watchlist names after the fixes (median value, base 9.25 % / LTCMA 7.5 %):** AAPL 174 / 265 (price 344),
MSFT 294 / 457 (533), GOOGL 159 / 249 (317), AMZN 87 / 155 (249), NVDA 139 / 224 (216), NFLX 56 / 91 (64),
TTD 16 / 23 (13). Still structurally low: NOW (GAAP margin ≪ FCF margin, SBC), MRVL (no own S2C), PLTR (growth beyond
base rates) → next fixes. No universe rerun until the watchlist looks right (Jamie 10-27).

## Assessment 10-27 night (Jamie: "why so far from price and from analysts, why so wide?")

Evidence: walk from analyst-style to ours on AAPL / MSFT / NVDA / NFLX / GOOGL (deterministic median path), outside
estimates (street PT, LSEG StarMine intrinsic value, Morningstar fair value), and range-width decomposition.

| step (cumulative) | AAPL | MSFT | NVDA | NFLX | GOOGL |
|---|---|---|---|---|---|
| ours (base-rate growth, margin fade, tax → 25 %, ERP 4.25 %) | 149 | 252 | 115 | 45 | 154 |
| + tax held at effective | 161 | 267 | 125 | 49 | 165 |
| + margins held | 188 | 317 | 160 | 58 | 198 |
| + years 2–5 at analyst LTG, fade by year 10 | 301 | 537 | 640 | 131 | 287 |
| price · street PT · StarMine IV | 344 · 327 · 151 | 533 · 600 · 377 | 216 · 325 · 250 | 64 · 86 · 58 | 317 · 427 · 263 |

What we are doing wrong (most → least):
1. **Growth after year 1 comes from history, not the company.** Years 2–10 use the base-rate CAGR of all
   similar-size, similar-growth firms (megacaps ≈ 5–8 %/y), lightly tilted toward analysts. Analysts and the market
   use company forecasts (consensus FY2–FY3 revenue, guidance). Base rates should be the *prior* the company forecast
   is shrunk toward, weighted by coverage and forecast quality — not the centre. We also lack FY2/FY3 revenue
   consensus, and IBES LTG is EPS growth (NVDA 52 %, NFLX 21 %), the wrong unit for revenue → over-shoots when used raw.
2. **Margin fade from the cross-section.** Median future/current ratio 0.87 for 30–40 % tech margins is an average of
   all such firms; applied to every company it cuts stable franchises by 13 %+ and adds most of the width.
3. **Tax stepped to 25 %** for companies with long-run 15–18 % effective rates (−7 %).
4. **Discount rate is a real choice, not an error:** ERP 2.5 % (JPM-consistent) vs 4.25 % moves values ~60 %.
5. **Width = cross-sectional dispersion used as company uncertainty.** P90/P10 with one input random: margin 2.3–2.7×
   (NVDA 13×), growth 1.6–2.3×, ERP 1.15×, terminal g 1.1×, reinvestment ≈ 1.05×. The spread of *all* firms in a
   bucket is not the uncertainty about AAPL. Uncertainty should come from the company's own forecast dispersion
   (analyst high/low, own margin/growth volatility) — base-rate dispersion only for thinly covered names.
6. **Street targets are not fair values.** They are 12-month price forecasts, mostly multiple-based, optimistic by
   ~10–15 % on average (FINDINGS §2). Public intrinsic values exist: Morningstar FV (MSFT 600, NFLX 80), LSEG StarMine IV
   (in our DB). Intrinsic estimates sitting below megacap prices is normal (StarMine AAPL 151), not a sign of a bug.

Fix order (watchlist only): (a) revenue + EBIT consensus FY1–FY3 per company (IBES SAL/EBI via WRDS for the watchlist,
LSEG after 11-01) as the growth/margin centre, shrunk toward base rates by analyst count and dispersion, fading to base
rate by year 10; (b) margin centre = consensus/own, uncertainty = own history + analyst dispersion; (c) tax → company's
3-y effective, partial convergence; (d) width check vs Morningstar uncertainty bands (fair value ±20–50 %);
(e) compare with StarMine IV / Morningstar as plausibility bounds, not targets.

Built 10-28 (a)–(c), watchlist only: LSEG consensus FY1–FY3 (`consensus_annual`) drives years 1–3; margin = GAAP +
consensus margin change; tax halfway to 25 %. Megacap P50 now near StarMine IV (NVDA 241 vs 250, MSFT 359 vs 377,
GOOGL 238 vs 263). Before/after per name in A283 status notes. Next: (d) width, loss-maker path-to-profit, SBC scenario.
