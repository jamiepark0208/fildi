# Quant commit review packet — 2026-11-03 part B
Range: `b5f33ac7..HEAD` (`cursor/mac-dev`). Read-only. No Muse review lines read.
Study ids: A297→S128, A298→S129, A299→S132 (S124/S125/S126 already used).

## A314 — Regime program sweep
SHAs: `2bceb940` S142 · `dc0d1f7d` S143 · `85790277`/`4dc51ed6` S144 · `5d591542`/`0a49774f` S145 · `2d36c1d7`/`3fc08990` S146 · `cae9f691`/`6f5ede61` breadth live · `6e471f96` trend-fall live.
Verdict proposal: **pass**
pass, checked:
- Families 1–5 grade the claim, print both halves, and print an MDE. No arm is BETTER on `put_benchmark` (breadth skip −5.4 bp t −2.6; mesa skip −3.3 bp; chop skip −10.1 bp; rv_accel −20 bp). No put-score change.
- S144 MDE = 2.8×|eff|/|t| (vix9d 2.8×7.5/1.5≈14 pp, packet 13.7). Effects sit under that MDE with |t|<2, so the FAILs are powered.
- S145 same. hyg_ie_shock t −5.6/−7.0 is the opposite of “higher drop” (n=6/6) and was not shipped.
- Live trend-fall uses completed bars only (`intraday-regime.ts:505`) and EMA12 −0.15%/3 bars (`intraday-trend-fall.ts:15-19`). Shipped odds 0.13/0.30/0.31/0.45 equal the average of the two halves in `A314-tvtools-packet.md` (calm (10.1+15.5)/2=12.8). Incremental logit t +2.2/+5.9, same sign as “higher drop.” Raw placebo gap is negative because the flag loads on calmer unconditional states; the within-level table is the claim that cleared |t|≥2.
- Live breadth odds 0.10/0.17/0.22/0.33 sit ~2 pp above the S126 table (`intraday-risk.ts:54`), same size as the packet’s +1.9/+2.5 pp gap. Gate t +5.0/+4.0 is in the packet. Level is not overwritten.
- Family 6 (GEX) correctly not graded: `gex_daily` has a few sessions (see A311), bar is ≥60.
- S142 hawkes effect +16.4/+9.5 with t −0.9/−1.6 (sign disagrees) and cusum_ret +4.1 with t −0.7. |t|<2 either way, so the family FAIL stands. Fix the printer before reuse.

## A309 — Per-stock regime flags vs own-IV put breach
SHA: `c8e4e16c`. Script `analysis/a309_stock_regime_flags.py`. INDEX S-row not separate; result is the A309 packet.
Verdict proposal: **pass**
pass, checked: no flag has |Δ|≥2 pp in both halves with week |t|≥2. ER20>0.4 is −0.6/−1.9 pp (t −2.3/−1.1). KAMA −1.9/−2.3 (t −1.9/−1.5). ATR +1.4/+0.0. Own-IV strike, Monday entries, logit after put_edge+IV/RV. No `put_recs` edit.
MDE line is the wrong SE: `mde_weeks` (`a309_stock_regime_flags.py:314-320`) treats each week as one coin flip. At base 13.6% and 436 weeks that is ~6.5 pp; packet says 7.7. ER H1 t −2.3 at −0.6 pp implies SE ≈ 0.26 pp, so the 2 pp bar is well powered. FAIL stands. Hand check is the formula, not two tickers (cross-section).

## A310 — Alpaca wheel score vs Fildi put engine
SHA: `3d075256`. Packet `out/opt/A310-packet.md`.
Verdict proposal: **pass** (plan’s second clause; the script’s own FAIL string is the 0.5 bp cutoff)
pass, checked: holdout book (c)−(a) = −3.2 bp, week t −0.7, worst-5% −31 vs −101 bp, breach 7.6% vs 16.9% (`a310_wheel_baseline.py:150-151` requires |Δbp|<0.5, so the script prints FAIL). Plan text is “equal P&L with a lower worst-5% week.” t −0.7 is equal; the tail is lower. H1 engine +27.7 vs Alpaca +15.3. Engine n 23,031 vs Alpaca 64,636 because panic weeks are not traded; worst-5% is the left tail, so idle weeks (zeros) do not create the tail gap. Idle weeks are scored 0, not T-bill; adding T-bill would raise the engine book. No engine edit.

## A308 — Forward ledger earnings_up + StarMine + skew
SHA: `77da7a27`. `forecast_ledger.py`.
Verdict proposal: **revise**
1. Skew probability is clipped for almost every name. Claim: `p = 0.5 − 2·(skew−median)` is applied to skew in vol points (`skew_up_prob`, line 98-102; `_vol_pts` ×100). A 0.075 vol-point gap from the median already hits 0.35 or 0.65. Evidence: unit test `skew_up_prob(2.0, 0.0) == 0.35`. Live ledger `qtype=earnings_up`: 96 skew rows, 41 at ≤0.351 and 47 at ≥0.649 (88/96). ETN skew 2.783 vol pts → 0.35; SWKS 1.074 → 0.65 (2026-11-03 reports, signal day 2026-11-02). StarMine scale is fine (NU +3.70 → logistic ~0.57, not clipped). Fix: apply the 2× to decimal skew, or ~0.02 per vol point, and re-log.
2. Look-ahead on the join is clean: skew only once `today >= report−1`, StarMine `as_of <= today`. Base rate 0.48. Acceptance “≥1 row” is met (1,596 base_rate). The mapping that will be graded later is not a probability.

## A307 — Grade Live hotlist entry verdicts
SHAs: `7e48264a` study · `42d63771` drops the market-direction gate.
Verdict proposal: **pass**
pass, checked: enter vs avoid breach gap −0.1 pp (16.2% vs 16.1%), day t −2.3/−3.5, placebo ~0. Bar is ≥3 pp. With t −2.3 on a 0.1 pp gap the 3 pp bar is far above the SE. Risk-only variant t −0.1/−1.6, not shipped as a gate. `verdictFor` (`intraday-entry-signals.ts:137-149`) uses the ticker’s own direction. `regimeDirection` is logged, not passed in. No put-score weight change.

## A295 — S123 earnings-cycle + geopolitics
SHAs: `c37c16ae` `a00ba64f` `d88182eb` `e5da4a0a`. Card `out/opt/S123.md`. INDEX says T1 R2/R3 PASS.
Verdict proposal: **revise**
1. The PASS is a contrast picked after seeing both halves. Pre-reg Test 1 is downcycle vs upcycle, +15 pp P(DD≥10%) in 2016–20 and 2021→. Round 1 FAIL (downcycle n=4). Round 2 swaps in “late” and both halves pass (62% vs 9%, n=16/11; 46% vs 25%, n=37/28). The protocol says pick on the fit window, then touch the holdout once.
2. Placebo (B shifted +6 months and −12 months) is not in `s123_earnings_geo.py` (no `placebo`/`gpr`/`oil`). Geo stress (GPR 90th, WTI +15%) was never computed. Half the pre-registered study is missing.
3. Early-window 62% vs 9% is monthly overlapping 6-month drawdowns with no t and no block count. One 2020 path can fill many “late” months.
4. Test 2 FAIL is real on the printed table: no structure has |Δ|≥0.25% and t≥2 in both halves (jade +0.60% t 2.08 early, −0.47% late). Metric is S076 monthly equity, not per-trade net. Test 3 is one sentence (“band shift < 5 bp”) with no table in the script output. INDEX should not say T1 PASS until the placebo and a fit-only pick exist.

## A297 — S128 far-OTM 0DTE after an SPY drop (filed as S124)
SHA: `708e245e`. `analysis/s128_reversal_convexity.py`. INDEX FAIL profit/$ −0.96 matches the 1.5% cell.
Verdict proposal: **revise**
1. The d grid is not estimated. `real_prints` breaks after the smallest d that fires (`s128_reversal_convexity.py:183`, comment “first d only”). Smoke 2025-04-08 fired 1.5% and 2% at 14:00 (open 521.86 → 506.40). The results table has n=0 for 2% and 3%. Every day that hits 3% also hits 1.5% first, so the lower strikes the plan asked for were never priced.
2. The 1.5%/1% cell itself fails the bar: n=10, profit/$ −0.96, max multiple 0.27×, drop-best-day −0.98, CI low −1.00. That cell does not need a power excuse. Mirror, short side, 200-day and panic filters are not in `out/opt/S128.md`. Fix: score each d on its own trigger, then the three rounds, before closing the study.

## A298 — S129 long calls when VIX/VIX3M falls back under 1 (filed as S125)
SHA: `611da74a`. `analysis/s129_post_panic_longs.py`. INDEX FAIL matches the packet.
Verdict proposal: **revise**
1. “Same-risk stock” is the unlevered stock return. `trade_call` sets `stock = exit_S/S − 1` (line 111-112) and compares it to option pnl per premium dollar (+35% to +130% vs stock +1% to +9%). The plan is stock sized to the option’s vol. Seven cells “beat stock” on that mismatch.
2. The sold-put proxy is +100% in both halves (n=11). The code is a real BS put (`(put−intrinsic)/put`, line 214-215), and three episodes finish higher 30 days later, so OTM expiry is plausible there: SPY 2022-02-25 437.75 → 2022-03-28 455.91 (iv30 call 22.0); 2020-04-24 282.97 → 2020-05-26 299.08; 2024-08-08 530.65 → 2024-09-09 546.41. A put that never pays intrinsic is not the S101 collateral book (bp/wk, breaches, T-bill). Fill is mid, no 23% spread haircut (packet says MODEL). Arms B/C in the ask (S087 run-up, HY OAS) are not in the report. Fix: vol-matched stock, S101 put in bp per collateral, haircut, then one holdout. 16 episodes clear the count bar.

## A299 — S132 crashed themes with rising revenue forecasts (filed as S126)
SHA: `d267e4b6`. `analysis/s132_crashed_rising.py`. INDEX matches (−4.7 pp fit / −144 pp holdout; puts +41/+23).
Verdict proposal: **pass**
pass, checked: 3 fit rounds then one holdout. Best call arm (crash ≥20%, 60 DTE, 0.40Δ) rising−falling −4.7% fit / −144 pp holdout; stock −0.1% / −12.3%. Calls lose to stock on the fit (−27.3% vs +0.4%). Opposite side (short puts) is the positive result and is reported, not shipped. Revisions go through `flows.py` fpedats match (line 219-228). Fit ≤2022-12, holdout ≥2023-01. MODEL mid (no haircut) makes long calls look better than a real fill, so the loss is not an artifact of rich pricing. −144 pp is a difference of two returns, not a single-call loss past −100%.

## A232 — S135 earnings read-across (reported PASS)
SHA: `d4606f09`. `analysis/s135_earnings_readacross.py`. INDEX repeats PASS, HO hit 61%, iv rel +11%.
Verdict proposal: **revise**
1. (b) full-sample hit rate is 57.9% (n=1233), under the 58% bar. `b_pass` is the holdout only (line 249-251, 61.1% n=373). The “fit” column in the review packet is the full sample, holdout included. No ≥5-analyst filter. IBES is `meanest` with no fpedats match (line 132-137). Hand check, NVDA report 2025-11-19 (move −3.15%, calendar surprise +3.17% so the script calls it hot): next AVGO snapshot meanest 6.67 → 10.01 because fpedats rolls 2025-10-31 → 2026-10-31. That is a year roll counted as a positive revision. MU Nov→Dec 17.0 → 28.35 stays on fpedats 2026-08-31 (a real revision). Rolls bias the hit rate up whenever FY2 > FY1.
2. (c) “+11.3% relative” divides (hot−cold) by mean(|Δiv|), not by the implied-move level (line 266-267). Holdout hot −0.0028 vs cold −0.0062 is a 0.34 vol-point gap. On a ~30 vol name that is ~1% of IV, not 10% of the move. Realized/implied (`|move|/(iv·√(1/252))`) is not computed. Same-chain vs other sub-industry is named in the docstring and absent in the code. Crowding split is on (a) only (n=176); the plan says no headline without it. (c) window is the 5 sessions before the peer print (`iv_change`, line 108-114), which includes days before the leader when the peer reports inside a week.
3. Holdout is `date >= 2025-01-01` (docstring: two calendar years). The binding spec is the last two seasons, untouched. Fix: fpedats-matched revisions, fit-only (b), level-relative (c) plus realized/implied and the industry control, then re-grade. Do not wire S066 on this PASS.

## A195 — S134 cointegration put filter (reported FAIL)
SHA: `7e2fd689`. Packet: 5 pair-years < 10.
Verdict proposal: **revise**
1. A power gate ran, and 5<10 is what the script prints (`s134_coint_put_filter.py:186-200`). Formation is trailing 2 years (`days <= form_end`), so that part is point-in-time.
2. The registered gate is per style. Jamie’s add-on: report the power gate for value/value and growth/growth, no pooled BH if signs differ. `style_label` (line 115) is never called. BH is one pool of every pair in every peer group that year (line 102-111), which is stricter than a within-style BH. The stop may be an artifact of pooling. Fix: BH inside each style, print pair-years, stop only if both styles are <10. No outcome tests until that number exists.

## A221 — S140 cluster book cap vs sector cap (reported FAIL)
SHA: `141f110e`. `out/opt/S140.md`.
Verdict proposal: **pass**
pass, checked: vs the sector cap, cluster worst-5-week −455 bp vs −429 bp (bar is a ≥25% smaller loss, i.e. about −322 bp) and blocked 90% vs the 30% cap (`s140_book_concentration.py:310-318`). Book still holds 10 names (383 weeks all policies), so “blocked” is the share of scanned names, and the book is not smaller. N_eff is `1/sum(w^2)` and ignores covariance (`effective_bets`, line 120-124), so the printed 10.00 is the position count. Stress covariance is calm Ledoit-Wolf ×1.5 on both branches (line 152-156); the 1.5 cancels in shares and does not use future crisis days. Sized ×0.7 has no T-bill on the idle 30%; that comparison is not the pass bar. No trading rule shipped. The tail miss is large versus the 25% bar, so a missing MDE line does not rescue it.

## A222 — S141 downside OHLCV ranker (reported FAIL)
SHA: `f52075b3`. `out/opt/S141.md` mean partial IC +0.003. INDEX matches.
Verdict proposal: **revise**
1. The printed t is not the pre-registered month-cluster t. `partial_ic` (line 159) is mean(daily IC) / (sd/√n_days). The bar is month-cluster t≥2 after put_edge+iv_rv. No MDE line. On 2024–25, IC +0.007 and t 1.05 ⇒ day-level SE ≈ 0.0067, MDE at |t|=2 ≈ 0.013 (under the 0.02 bar). If within-month ICs move together, month SE is wider and 0.02 sits inside the interval. Point estimate +0.003 is the center, not a demonstration that 0.02 is ruled out.
2. The 1-week embargo is missing. Label is min close over the next 7 sessions (`s141_downside_rank.py:70-73`). Folds cut on 31 Dec / 1 Jan (line 31-34), so the last training week uses test-year prices. That leakage inflates IC; it cannot manufacture a FAIL. Holdout put-pnl spread +14.7 bp has no t. Fix: month-cluster t, MDE, embargo, then keep or drop the FAIL. Features themselves are lagged (ret/ma through `c[i]`).

## A311 — SPY/QQQ GEX daily log (units and sign only)
SHAs: `57623698` build · `209bae72` session date + grid flip.
Verdict proposal: **pass**
pass, checked: `contractGexDollars` = γ·OI·100·S²·0.01, calls +, puts − (`gex-daily-math.ts:29-31`). Stored rows: call>0, put<0, call+put=net exactly. 2026-11-02 SPY spot 755.49, net −9.67e9, call +1.29e10, put −2.25e10, flip 768.54, n=3380. QQQ spot 685.67, net −5.27e9, flip 717.43. Spot < flip with net < 0 on 2026-10-29, 10-30, and 11-02 for both names (short-gamma side of the flip). Schwab IV percent→decimal (`normalizeSchwabIv`). `as_of` defaults to `lastCompletedSessionYmd()` (`gex-daily.ts:117`). Scale is billions of dollars per 1% move, the usual SPY/QQQ order. No range study (family 6 waits for 60 sessions).

---
Summary: pass 7 (A314, A309, A310, A307, A299, A221, A311) / revise 7 (A308 skew clip, A295 T1 PASS, A297 d-grid, A298 comparators, A232 PASS, A195 style gate, A222 month-t) / could-not-check 0.
