# Step 4 v2 conclusions (2026-10-05): evidence → proposed model changes (need user approval)

Data: 17,245 reconstructed monthly ~0.20Δ 30-day puts, 258 tickers, Mar 2020 → Sep 2026 (2020 crash, 2022 bear, 2023–26), priced from
LSEG 30d ATM put IV (Black-Scholes validated vs a live Robinhood quote). Full tables: `backtest_puts.md`.

**Method lesson:** scoring by raw return mechanically favors high-IV names (bigger premium) and made StarMine alpha look strongly *negative*
(t −15). The right targets are **premium kept** (P&L ÷ premium) for income decisions and **3-month return vs sector peers** for "own"
decisions, each also measured with IV held fixed. All conclusions below use those.

Robust = same sign and |t| ≥ 2 at 0.15/0.20/0.25 delta and 0.70/0.85 fill haircut.

| # | Finding | Evidence (IC with IV held fixed) | Robust? | Proposed change |
|---|---|---|---|---|
| 1 | **IV rich vs realized vol is the main put-selling edge** | premium kept +0.040 to +0.041, t 4.1–4.6 | ✅ | PREMIUM pillar: IV/RV 60% → **70%**, add IV rank 30% (+0.020, t 2.5), **drop raw IV level** (40% today; premium kept −0.03, no edge) |
| 2 | **StarMine combined alpha predicts both outcomes** | own (63d vs peers) +0.038, t 3.8 · premium kept +0.020 to +0.029, t 1.9–2.5 | ✅ own / ~ income | Keep STREET as a scaled reward/penalty (user's framework). It earns weight mainly in the **green/own** verdict, less in income |
| 3 | Predicted surprise helps "own" only | own +0.019, t 2.2 · kept ≈ 0 | ~ | Keep its weight in STREET; no separate income effect |
| 4 | **Sector-relative alpha is no better than raw** | own: rel-peer +0.037 vs raw +0.038 | ✅ | Keep STREET raw. The energy clustering (MPC, CVX, XOM…) reflects real, predictive revisions, not noise |
| 5 | **Earnings inside the window raise blow-up risk** | +1.0 to +1.4 pts of losses beyond 1σ, t 1.9–2.6 | ✅ | Keep the L1 earnings-before-expiry block |
| 6 | **"Falling knife" (proxy) does not hurt put sellers** | risk-adj return +0.017 to +0.025 (t 2.2), no more tail losses | ✅ (proxy) | Cut falling-knife severity 0.5 → **0.2** in fit-1.4 red; re-test with Fildi's exact `falling_knife` definition once tech snapshots exist |
| 7 | Q1: self-relative oversold ≥ cross-sectional for puts | premium kept +0.021 (t 1.6–1.9) vs −0.005 | ~ | Supports keeping technicals self-relative (user's view). Add sector-relative momentum as a small input (+0.018, t 2.1) |
| 8 | In broad selloffs, "self-oversold" names did worse | IC −0.052, t −2.5, only 8 selloff months | thin | Candidate for Step 7's regime pause: don't lean into dip-buying puts while SPY's 20-day move < −5% |
| 9 | Not testable yet | fundamentals (no point-in-time history), ARM revisions (no LSEG history; half of STREET), credit rank | — | WRDS IBES revision history (Cursor lane) as the ARM proxy; fund/tech snapshots per A14 |

**STREET size:** the evidence supports a modest effect (ICs 0.02–0.04 are typical for real factors), which matches K = 8 points at most, with
mild readings near 0. To be recalibrated in Step 6 from the live ledger and the WRDS revision history.
**Green threshold:** not settled here (needs fundamentals history). Until then the shadow's 58 greens stay a shadow.
