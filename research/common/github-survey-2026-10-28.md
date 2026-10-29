# Public-repo survey vs Fildi's judgement calls (Claude, 2026-10-28)

Jamie: "these problems have most likely been solved by others and exist in public git projects — find them, compare, copy/test."
Method: `gh search repos` (29 queries, sorted by stars) per Fildi decision area; read README/core logic of the top hits; copy and
run the ones that make a testable claim on Fildi's own harness (walk-forward, no look-ahead, both halves). Raw hits:
`scratchpad gh_survey.txt` (not kept). Verdict key: **tested** (study id) · **dispatched** (ASKS) · **compare** (logic read, Fildi already
does more) · **skip** (why).

| Fildi area (where it lives) | Public implementations found | What they do | Verdict |
|---|---|---|---|
| Market regime (Live tab, Key Themes market state) | Yizhan-Oliver-Shu/jump-models 172★ (Shu & Mulvey 2024) · hmmlearn HMM repos (JINGEWU 320★, many) · jackson-video-resources/markov-hedge-fund-method 493★ · LSEG-API-Samples regime article · TradingView detectors (8) | Unsupervised 2-state bull/bear (JM, HMM) on EWM return / downside-dev / Sortino; 20 d ±5 % transition matrix | **tested S136** — JM ≈ 200 d MA but steadier (1–2 switches/yr), halves drawdown, no 5-day return edge; HMM/Markov worse. **tested S130 v2** — TV detectors: no direction, breach yes (ER, ATR pct) |
| Intraday regime (Live checkpoints) | Opening-range / intraday-momentum repos (thin, < 30★) | ORB rules, Gao et al. momentum | **tested S126/S131/S124** — direction ≈ coin flip; rest-of-day risk works (shipped) |
| Volatility forecast / "options too cheap" | bashtage/arch 1.6k★ (GARCH) · HAR-RV repos (talaikis, deep-hedger-Peng SPY) | GARCH/GJR, HAR-RV forecasts | **tested S137** — GARCH > own IV fails as a breach flag (t 0.7 / 2.5); HAR already S033 |
| Dealer positioning (not in Fildi) | Matteo-Ferrara/gex-tracker 223★ · gammagrid 91★ · EzOptions-Schwab 45★ (Schwab API!) · Edge-GEX-Lab | Dealer gamma exposure by strike, gamma flip, walls | **dispatched A311** — positive/negative gamma is the best-known *volatility* regime signal; needs OI snapshots → log forward + test |
| Sold-put strike choice (put_recs.py engine) | alpacahq/options-wheel 135★ · GitOffMyPorch/Robinhood-options-screener · liuxie066/options-monitor · sbauwow/schwagent (Schwab wheel) | Score = (1 − \|Δ\|) × 250/(DTE+5) × bid/strike, Δ band + OI + yield filters | **dispatched A310** — Fildi's engine is richer (backtested bands S101, put edge, IV/RV); run the Alpaca score head-to-head as a baseline on S088 candidates |
| Options backtesting (S088/S076/S101 harnesses) | goldspanlabs/optopsy 1.5k★ · lambdaclass/options_portfolio_backtester · lumibot 2.2k★ | Strategy backtests on stored chains | **compare** — Fildi already backtests on real LSEG/Schwab quotes with fill haircuts; optopsy is a cross-check, not an upgrade. Revisit if a harness disagrees with live fills |
| Earnings move (S018, S066, S127) | martex-dev/implied-move · cutemarkets/options-earnings-lab · PEAD replications | Implied move from straddle; mean-abs vs 1σ distinction; realized/implied | **compare** — S018 compares straddle (≈ mean-abs move) to realized abs move: consistent. Direction: S127 FAIL; skew forward ledger A308 |
| Stock ranking / factors (fund score, S089/S090) | microsoft/qlib 49.8k★ · quantopian/alphalens 4.5k★ · skfolio 2.6k★ · mlfactor book | ML factor models, factor tear sheets | **compare** — S089 (210 published signals) + S090 (JKP 153) already tested the factor zoo; alphalens = nicer tear sheet only. Qlib's LightGBM ranker = candidate if a ranking study wants ML |
| Support / resistance (S039–S041) | GregoryMorse/trendln 733★ · day0market/support_resistance 475★ · PatternPy 480★ | Pivot/trendline clustering | **skip** — S039–S041 already tested S/R levels for puts (results in INDEX) |
| Fair value / DCF (fv-1.0.0, S116) | halessi/DCF 501★ · equity-research-skill 469★ | Textbook DCF | **skip** — Fildi DCF is more complete (footnotes, PIT); no claim to test |
| News / sentiment (OpenJev, S037) | ProsusAI/finBERT 2.3k★ · yya518/FinBERT | Sentence-level sentiment | **skip** — S037 tested LLM labelling (better than FinBERT in the literature); no edge as a trade signal |
| Sizing (wheel collateral, S087) | PyPortfolioOpt 6.1k★ · Riskfolio-Lib 4.6k★ · kelly-criterion | Mean-variance, HRP, Kelly | **skip for now** — sizing is per-trade breach/collateral (S087); revisit with a portfolio-level optimizer ask |
| Indicators library (lab_tech, TS indicators) | TA-Lib 1.7k★ · bennycode/trading-signals 1k★ (TS) | Reference indicator math | **compare** — use as reference when an indicator is ported (ADX/KAMA/CHOP in S130 match Pine definitions) |

## What the survey changed
1. **Found my own error.** Copying GARCH (S137) showed S130 v1's best flag (RV20 > VIX) was an artifact of sizing QQQ/IWM puts with VIX. Fixed
   (S130 v2: each ETF's own IV), the Live "1–2 wk put risk" now uses the two flags that survive (ATR pct, efficiency ratio).
2. **Power, not just pass/fail.** Our two-halves t ≥ 2 bar on 4 index ETFs detects a true IC 0.05 only 8 % of the time. Weak signals need
   the cross-section (hundreds of names, own IV) — dispatched as A309.
3. Public regime models (JM/HMM/Markov) confirm the TradingView result: regimes describe risk/drawdown state, not next-week direction.
