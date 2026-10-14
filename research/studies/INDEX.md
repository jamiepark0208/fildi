# Research studies — catalog
> **Check here before starting any analysis, backtest or "is X an edge?" question.** One row per study; the link is the full report.
> How to add one: `README.md`. Method rules every study must follow: `METHODS.md`. Factor homes: `scripts/watchlist_sync/FACTOR_MAP.md`.
> Paths: `out/` = `scripts/watchlist_sync/out/` (markdown versioned, data local) · `analysis/` = `scripts/watchlist_sync/analysis/`.

Status: **adopted** (changed the live model) · **display** (shown, not scored) · **rejected** · **open** (accruing data / awaiting decision) · **superseded**

## Catalog

| ID | Date | Question | Answer (one line) | Status | Report · re-run |
|---|---|---|---|---|---|
| S001 | 10-05 | What does each scorecard measure, and is it testable? | 5 scorecards; missing data re-weighted away everywhere; only fund is peer-relative; no history to backtest tech/options yet | adopted (A14 snapshots) | `out/step2/scorecard_audit.md` |
| S002 | 10-05 | How should analyst views (STREET) enter the verdict? | Scaled reward/penalty K≈8; flags-only variant moves the fewest names; overlap with fund IBES low (ρ 0.14–0.19) | adopted (fit-1.4) | `out/step2/street_scenarios.md` · `analysis/street_scenarios.py` |
| S003 | 10-05 | Which factors predict put outcomes (17k reconstructed puts 2020–26)? | IV/RV is the main edge (t 4+); StarMine predicts both jobs; earnings-in-window raises blow-ups; falling knife harmless; raw IV level no edge | adopted (fit-1.4 PREMIUM, severities) | `out/step4/conclusions.md` · `analysis/backtest_puts.py` |
| S004 | 10-05 | Are the live scorecards (tech v2/v4, options, fund) predictive? | Tech totals predict nothing; only long-term trend passes; 0.7 IV/RV + 0.3 IV rank passes everything; revisions redundant with trend; oversold/RSI no edge universe-wide | adopted in part (A25 T/O/F items) | `out/lab/conclusions.md` · `analysis/lab.py` |
| S005 | 10-05 | What makes a put trade good — income vs ownership? | Ownership (StarMine alpha, trend, low idio vol) predicts; premium kept barely predictable; drawdown needs a thesis; selloff + rich VRP pays; covered call − hold ≈ −0.79%/mo | adopted (trader-context rewrite) | `out/step8/conclusions.md` · `analysis/factor_pca.py` |
| S006 | 10-05 | Can a regime label + confidence model size trades? | Confidence model failed (Brier skill −6.4% puts); regime dial shown as scenarios only; top-20 PREMIUM ladder 0.86%/mo 2024–26 but 0.24% 2020–23 | rejected (model) / display (regime) | `out/proto/gate1.md` · `analysis/proto.py` |
| S007 | 10-05 | Simple "wins historically" lookup by delta × DTE? | Passes (gap ≤ 4.7 pts between eras); per-stock blend adds nothing (Brier equal) | adopted (Model List win-rate table) | `out/proto/gate1b.md`, `gate1c.md` · `analysis/proto_b.py`, `proto_c.py`, `winrates.py` |
| S008 | 10-05 | fit-1.4.x versions and learning cycle vs fit-1.3 | Verdict transitions listed; learn.py cycle: champion consistent with evidence | adopted (fit-1.4.3 champion) | `out/step2/fit_v14_shadow.md`, `out/step6/` |
| S009 | 10-06 | Does a blended fair value (or valuation factors) predict returns? | Cheapness gaps don't time returns; forward EPS growth and PT revisions do (fwd growth t ≥ 3.1 → fund-1.1.0); value-trap flag t 3.4 | display (fv-1.0.0) + adopted (ibesFwdGrowth) | `research/fair_value/FINDINGS.md`, `FACTOR_STUDY.md` |
| S010 | 10-06 | Does using today's survivors bias the put backtests? | ≈ 0 at ≥ $3 / ≥ $300M; high-vol small caps +0.10 pt/mo → read 0.86%/mo as ≈ 0.75–0.8% | adopted (haircut on readings) | `out/survivorship/report.md` · `analysis/survivorship.py` |
| S011 | 10-06 | Does the trader's own entry timing (puts after dips/support, calls after rallies) work? | Yes in direction: put ITM 17% after a dip vs 26.5% without; calls 10% after a rally vs 20% without; P&L gap not yet significant | display (setup tag) · open | `S011-rh-entry-timing.md` · `analysis/timing_rh_trades.py` |
| S012 | 10-06 | Robinhood strategy review: what is it, is it viable, how should verify price contracts? | Weekly high-IV wheel; +$40.4k wheel P&L (HOOD +$21k); viable as VRP harvest, edge is selection + timing; RH fill = bid + ~23% of spread; spread blocks were mostly close-of-day quotes | adopted (spread rule, Schwab re-price, margin rule, FILDI folder) | `S012-rh-strategy-review.md` |
| S013 | 10-06 → | Are the Robinhood verify blocks right? (counterfactual grade of every checked contract) | First grades 10/09; decide per check at ≥ 30 rows | open | `out/block_audit/report.md` · `analysis/block_audit.py` (daily) |
| S014 | 10-07 → | Daily reflection: market, ideas found-but-wrong / real-but-missed, trader's day vs our scores, option_score rank IC (IV fixed) | Day 1: IC ≈ 0 (raw +0.05, IV fixed +0.02, 10 day-sides); trader's 14 opens on 10/07 all off the Model List, 10 were no-dip puts | open | `out/reflection/<date>.md` · `log.csv` · `analysis/daily_reflection.py` (daily) |
| S015 | 10-14 | Which of the trader's short puts were mistakes vs bad luck? (935 puts, Feb–Oct 2026) | Picks fine (+0.36% of collateral/trade, no entry feature survives Holm except earnings-in-window, confounded: trader went wider + richer IV, 27 events). Assignment neutral (fwd excess ≈ 0 at 5/10/20d, trader + 3k broad sim). Closing ITM puts ≈ neutral; buying back OTM puts cost $3.7k (92% didn't help). Breaches cluster by expiry (SD 0.23 vs 0.09, p<0.001) → risk is book size, not picks | open (PM rules: stress at bad-week breach rate) | `out/mistakes/report.md` · `analysis/trade_mistakes.py` |

## Topic lookup (what we already know)

| Topic | See |
|---|---|
| IV vs realized vol, IV rank, option richness | S003 #1, S004 #5–8, S005 #6 |
| Oversold / RSI / MFI / reversal / dip-buying | S004 #3 (no edge universe-wide), S003 #7–8 (worse in selloffs), **S011** (works for the trader's own discretionary timing) |
| Trend, momentum, 52w drawdown | S004 #2, S005 #2 #5 |
| Analyst revisions, StarMine, IBES, price targets | S002, S003 #2–4, S004 #11, S005 #1, S009 |
| Covered calls | S004 #9 (don't sell into 20d strength), S005 (CC − hold −0.79%/mo), S011 (after a rally works), S012 |
| Regime, VRP, breadth, selloffs | S005 #4, S006, S004 #14 |
| Win rates, confidence, calibration | S006, S007 |
| Valuation, fair value | S009 |
| Backtest biases (survivorship, fills, vol mechanics) | S010, METHODS.md, S012 (fill position) |
| Wheel P&L, assignment outcomes | S005, S012 (`wheel.py`) |
| Verify checks, spreads, fills, Schwab vs Robinhood prices | S012, S013 |
| Daily mistakes, missed ideas, does option_score rank ideas live | S014 |
| Portfolio limits, margin, concentration | S012 (FILDI), `portfolio.py` |

## Next studies (pre-registered; claim one by adding an ID before starting)

| Question | Needs | Stop rule / pass mark |
|---|---|---|
| Exit rules: close at 50% / at 21 DTE / roll vs hold weeklies to expiry | `option_chain_history` (accruing from 10/06) ≥ 3 months, or own RH closes | beat hold-to-expiry on wheel P&L per collateral, both halves |
| Put spreads vs cash-secured puts on speculative names | chain history | lower worst week at ≥ 70% of the premium kept |
| Index put-write (SPY/QQQ/XSP) for FILDI | Cboe PUT/WPUT data or chain history | Sharpe ≥ SPY with drawdown ≤ 60% of SPY's |
| Setup tag live validation (S011) | live ledger, ≥ 100 own trades after 10/06 | same sign as S011 and bootstrap CI excluding 0 → propose as a score input |
| Verify thresholds (S013) | ≥ 30 graded rows per check | blocked group return ≥ passed group → loosen that check |
| Score ranking live (S014) | ≥ 8 distinct expiries graded, ≥ 100 ideas | mean IV-fixed IC ≤ 0 → option_score adds nothing over IV; > 0 with t ≥ 2 clustered by expiry → keep. A mistake kind repeating on ≥ 5 days → pre-register its own study |
| Fair value re-test | ~6 months of `fair_value_snapshots` (≈ 2027-04) | S009 pass marks |
