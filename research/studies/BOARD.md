# Strategy board — what works, what's dead, what's testing
> Read this before proposing any test (all agents). One line per verdict; detail lives in `INDEX.md`. Update the line when a study lands. Feeds Track Record › Strategies (A368).

## Works (passed out of sample)
| Rule | Number | Study | Live? |
|---|---|---|---|
| Model List puts: top-10/wk with P(kept) ≥ 90 % | N_eff≈130 wk · H1/H2 +/+ · +77 bp/wk vs +35 plain 1σ (2w holdout); A371 LSEG replay see packet | S088 · S047 | live |
| Rich-put lane: ≥ 0.9 %/wk, ≥ 10 % OTM, ≥ 25 % off high | N_eff≈131 wk · H1/H2 +/+ · survivorship-adjusted bp see A371; was +101 bp/wk t 5.7 | S109 | shadow lane |
| Panic puts: panic drop + IV30 > 48.7 | N_eff≈90+ wk · H1/H2 +/+ · kept +4.05 % vs +0.26 % | S054 | live (Strategies) |
| Sharp-drop regime (SPY 3m ≤ −8 %, VIX÷VIX3M < 1) → higher put Δ | N_eff≈100+ wk · both periods + | S101 | strategy_rules |
| Buy calls: rising revisions + strong 60d return | N_eff≈128 wk · H1/H2 +/+ · holdout +69.6 % vs revisions +43.1 % (t 2.0) | S100 | board gate |
| Structure choice per idea from signal-conditioned scenarios (S100 ideas: stock / call / spread / short put / put spread / cash) | NO-LIFT · N_eff≈128 wk · holdout sign flips | S206 | not live (V5 shows alternatives only) |
| Calls: low volume + not stretched above 200d | N_eff≈100+ wk · H1/H2 +/+ · +42.9 bp/wk OOS, t 4.6 | S046 | options-1.2.0 |
| Watchlist RSI14 < 25 → buy next open, 5 d | N_eff≈107 ev · t 0.35 · IPO mix confound | S160 | not promoted (IPO-name effect untested) | if a recent-IPO RSI study passes out of sample |
| Wide credit spreads → market-drop warning | N_eff≈50+ events · S&P −5 % in 21 d: 25 % vs 13 % | S028 | display |
| Skip engine put picks with 2+ bad-pick flags (5-day run-up, fresh earnings beat, lowest IV of the list) | N_eff 299 wk · paired +10.5 bp/wk t 5.2 · H1 t 2.9 / H2 t 4.6 · +22 → +32 bp/wk | S208 · S210 | live gate (put_recs, 11-27) |
| IV ÷ RV is the put edge | N_eff large · t 4+ | S003 / S004 | in fit score |

## Low N_eff (OOS edge; N_eff < 100 — Data checked per row)
| Rule | Number | Study | Live? |
|---|---|---|---|
| Index oversold: SPY/QQQ RSI14 < 25 → long 5 d | Data checked: SPY/QQQ LSEG daily 2003→2026-11 · n 17/14 events · N_eff 17 / 14 · halves mixed at RSI<30 | S159 | trigger chip (underpowered) |
| Market bottom: VIX÷VIX3M un-inverts → index calls + SPY puts | Data checked: SPY/QQQ LSEG + FRED VIX/VXV 2008→2026-11 · n 33–38 episodes · both halves + on calls | S172 | paper (Live board) |
| Market bottom per stock: top-beta fifth puts at un-invert | Data checked: LSEG daily ~930 names 2018→2026-11 · n 18 episodes · model prices | S173 | paper (Live board) |

## Dead — as of the date tested, not forever
Dead = don't re-run **the same test**. A variant is welcome when it names what is different (new regime, new data, new structure, fairer comparator, real costs). Kind: **cost** = gross edge smaller than the spread (durable; re-check only if costs or fills change) · **no-lift** = no edge in that sample (can change with regime → re-screen on the Re-check date with the newest data) · **framing?** = the test itself may be wrong (comparator, units, approximated dates) → audit (A371). `scripts/asks_revisit.py` lists due re-checks at session start.
| Idea | Why | Study | Kind | Re-check |
|---|---|---|---|---|
| State-conditional tilt (drawdown × IV÷RV × SPY trend) on IV-implied move odds | held-out Brier no better than one global 'IV overprices downside' correction (t +1.5); 7 regime-years, survivorship | S193 | power | CRSP delisted history or ≥ 2029 |
| Long calls after a single-name crash (the sold-put 'low' entry) | −9.0 % vs +10.8 % any day, both eras; you pay the rich IV that pays the put seller. The low that carries = market panic → bull call spreads (+19 % vs +1.6 %, t 2.1); buy calls when IV pctile is low | S177 | no-transfer | new data on real chains |
| Longer-dated / different-strike calls, profit-take/stop exits, low-IV long calls (strike × DTE 30–240 × exit grid on a real-quote surface, 917 names) | 240 DTE calls +11 / +5 % / $ (0.30/0.50Δ, h63; corrected 11-10 for A388 data-end truncation, was −5…−6) — still below 60 DTE to expiry (+15 % in ~42 td vs 63 td held), era 1 < 0; 120 DTE ≈ 60 DTE in variant B (+17 %) once long-dated IV is priced right (it sits above iv30 at low IV and moves only 0.2–0.45× iv30); best all-day config = 60 DTE 0.50–0.70Δ to expiry (+14 %) but era 1 ≈ 0 and < same-Δ stock; TP 2× / −50 % stop worse in every set; low IV pctile lift depends on the IV model (−1 / +8 %) → not a rule. First-pass '+38 % low-IV LEAPS' was a pricing artifact | S178 | framing fixed → no-lift | real long-dated call history (LSEG Workspace RICs) |
| Growth bonus on call picks (revenue accel, beat streak, FY1→FY2, SUE) added to S100 | 0/8 add to S100 (+69.6 % holdout); beat streak / surprise hurt (t −2.4 / −2.0); revenue accel works only post-2024; winners = theme names, not growth ranks | S174 | no-lift | theme-momentum rule tested, or 2027-05 |
| Probabilistic per-name long-call odds (historical-analog simulation, boosted P(win)) | none beats the S177 score; P(win) Brier skill ≤ 0 — win rate is flat 25–32 % in every state, edge is payoff size via cheap IV. Hard cuts replaced by ramps (same result, no cliff) | S179 | no-lift | new feature family or real-quote panel |
| Kronos zero-shot daily OHLCV price forecast (A347 P1, 32 paths, 60 origins, 5 names) | 0/3 horizons beat naive RMSE (SPY-only 1d 7.66 vs 4.97); 1d dir 48 % pooled; pull-to-mean (S180). Fine-tune level skill dead (S181) | S347 | dead | Jamie re-opens S184 paper only |
| Kronos as a vol / P(ITM) input for short puts (zero-shot, 49 names, post-pretrain 2024-07→) | vol forecast QLIKE 0.94 vs HAR 0.43, RV20 0.57, IV 0.27; P(ITM) Brier worse than implied and base rate; IV/k_rv pick IC +0.06 over RV20, t 1.2 | S182 | no-lift (UNDERPOWERED, 28 episodes) | pooled fine-tune or bigger Kronos model |
| Meta-label (skip/size) on IV/RV-ranked puts | walk-forward AUC 0.50–0.52; skip-worst-fifth +0.3 bp t 1.2, gone 2024→ — put losses are market-wide, not name-specific | S183 | no-lift | new feature family (e.g. real-quote skew) |
| Per-stock RSI cutoffs | 3–12 events per name; shrunk per-stock −0.23 pp [−1.33, +0.90] h5, −0.96 h10 vs global 25 out of sample (A378 centering fixed) | S160 | dead | if event count per name ≥ 30 |
| Intraday indicator signals (stock or options) | gross lift < spread; 0/144, 0/60, 1/221 | S152 · S155 · S156 · A362 | cost | cost |
| Short-term RSI dip entries (1m…1h), 21 names | every cell ≤ 0 after spread; best 1h RSI<30 −8.6 bp — **5m cells void** (B26: 24 h bars), other TFs pre-fix5 | A359 fix4 | framing? (A374/A375 fixed 91d0c17a; B26 open) | after B26 commit + fix4 re-run |
| Overnight carry | +10.8 bp/night gross, −5 mid / −21 cross → timing rule only (1m RTH path, pre-fix5) | A359 | framing? (fix5 landed 91d0c17a) | re-run on fixed engine |
| Iron condor / short call vertical, tuned (entry filter × DTE × Δ × exit, 30 names) | best train cell fails test 2024→: IC −21 bp/$BP/day t −0.77, call vert −15 bp t −1.11; naive CSP +1.6 bp t 4.0 (train) | S164 | no-lift | after B2 |
| Family B shapes on CSP entries (put vert, jade, front-ratio, BWB, 30 names) | all trail plain CSP at same BP: CSP +2.4 bp/$BP/day vs front-ratio +1.0, vert +0.8, jade +0.3, BWB −0.3; best test lift +0.04 bp t 1.35 | S165 | no-lift | if CSP entry rules change |
| Debit call/put verticals on MTF pullback, −50 % stop (238 names) | S166 loss was mostly the stop (fired 67–72 %); held to expiry ≈ Δ-stock (−0.04…−0.07 per $debit); entry has no direction edge (P 0.48/0.52); spreads beat stock only on +0.5…1.5σ moves | S166 | framing (stop + no-edge entry; skew not modelled) | A192 Part D2 (S100/S046 entries, no stop) |
| Bull call debit on S100/S046 entries, no stop (32 cells) | train 2021–23 every cell trails Δ-stock on same $debit (best −36 vs −17 bp/day); entries themselves negative that era; beats long call in 14/16 hold cells (−36 vs −39) | S167 | no-lift (vs stock); spread > long call | Part R skew-priced entries; dte7 exit bug |
| Momentum + cheap-vol loss-maker calls (S170 momentum ∧ IV30/RV20 own bottom tercile × 3-day time stop × 30 DTE 0.30Δ) | TEST +219 bp/$debit/day, vs same-Δ stock +142, vs any-day calls +228, both halves + (234/212), delayed entry +232; but cluster t 1.06, placebo p 0.11 (lottery payoff: median −29 %, 14 % double) | S171 | **UNDERPOWERED — promising**; live paper tracking (A244) | ≥ 100 live picks graded |
| Momentum entry for loss-maker calls (ret20 ≥ 16.6 % ∧ RSI14 ≥ 63 ∧ ret5 ≥ 7.8 % × 3-day time stop × 30 DTE 0.30Δ) | winners on loss-makers = momentum, not dips; TEST +83 bp/$debit/day vs any-day calls +121, vs same-$ stock +74, but −16 vs same-Δ stock, t 1.58, 2nd half −11, 388 dates; calls win only when move ≥ +10 % → S171 cheap-vol × earnings gate | S170 | rule fail (timing = stock edge, not call edge) | after S171 |
| Crash-day entry rule for loss-maker calls (buy next close after stock 5d ≤ −20 % or SPY 5d ≤ −4 %; exits hold/TP100 only) | this ENTRY × EXIT rule trails Δ-stock (test +53 vs any-day calls +32, −71 vs stock; train all < 0); SPY-crash arm = ~3 independent episodes in test → UNDERPOWERED, not NO-LIFT. Not a verdict on calls — timing not yet worked (S170: winner anatomy → entry/exit) | S169 | rule no-lift (stock-crash arm) · underpowered (SPY-crash arm); winner-pass: n/a → S170 is the winner pass | after S170 |
| Put spreads / strangles / straddles vs CSP | −$17.5k / −$12.4k vs CSP on the same entries | S020 | framing? (A371: per-$BP not checked) | 2026-11-07 |
| Stops, 50/75 % profit takes | −$13.7k (stop); takes lose on real quotes | S017 · S103 | no-lift | 2027-02-07 |
| Calendar / Fed / CPI / opex weeks | 0/22 | S026 | framing? (A371: approx CPI week) | 2027-02-07 |
| Streaks, post-earnings drift, bounce after drops | 0/12; fail; no edge | S030 · S032 · S025 | no-lift | 2027-02-07 |
| Sector-specific fundamental weights | 0/6 sectors better | S024 | no-lift | 2027-05-07 |
| Recession odds model | no skill vs base rate | S029 | no-lift | 2027-05-07 |
| Tech score totals | predict nothing | S004 | no-lift | 2027-02-07 |
| Falling-knife guard in a sector drop (skip puts while sector ETF still falling) | still-falling entries earn more (+95/+79 vs +42/+46 bp/wk), worst week better | S186 | no-lift | 2027-05-10 |

## Testing / queued
- S205 panic day (VIX ≥ 30 + inverted + ≥ 7 % off high) → ATM/+5 % index call spread +27 % / $ at 20 d vs naked call +11.5 % (median −17 %), short 5 % OTM put 85 % win; panic-day entry beat S172 un-invert entry on n 17 (UNDERPOWERED, model-priced) → real-quote test before any rule. Data checked: LSE 1d panel SPY/QQQ 2003→ · FRED VIXCLS 1990→ / VXVCLS 2007-12→ (binding) · 2008–2026 · n 34 SPY / 32 QQQ / 17 un-invert.
- S191 sweep-and-reclaim of the 20-day low as put-sale timing: screen +1.7 bp/wk bull / +3.5–7.4 bear vs same-vol peers (t 2.2–2.9, placebo ≤ 0.03, model prices) → full study on real quotes + intraday entry. Same screen: S/R levels = continuation in bull (don't buy puts at resistance), cheap-vs-own P/E = worse put sale.
- S190 watchlist context (research complete; integration unverified): 58 names, 2,821 IV/RV windows, 6,117 prior-level events, 107 S190 Notes incl. pilot. Existing survey recovers 14/20 selections/19 marks, timestamps unknown. Source acceptance: note-cache/quote-guard/contract failures; grading unit tests6/6 pass. [Measured findings, seven use cases and exact fixes](../common/reviews/watchlist-2026-11-10/S190.md) · A205/A370/A192; no strategy promoted.
- S178 panic risk reversal on names (sell 0.25Δ put + buy 0.50Δ call, 30 DTE, VIX÷VIX3M ≥ 1): +5.9–6.1 % / $ strike vs short put alone +2.2–2.4, both eras, t 2.6, 11/15 panic Mondays; the 4 losers = early panic weeks → pair with the S172 un-invert timing; call ≈ same-Δ stock (leverage, not option edge). UNDERPOWERED — 15 episodes
- S184 Kronos (pooled fine-tune, 242 names) mu/sd rank → top-fifth 0.50Δ 30-DTE calls +0.24 per $ debit over all calls, month t 2.8, both halves +; pre-registered mu fails (t 1.4), 28 origins, model prices. UNDERPOWERED — promising; paper it, then blend with S177 score
- A370 indicators as put-timing filters in the seller's universe (smoke 11-07: top-IV names, SuperTrend bear / below 200d / 5d drop → +1.8–2.5 vol pts IV−RV, t 4–9; RSI>70 and high-volume days −4.4; works when SPY > 200d, fades in broad sell-offs)
- S159 → short puts on index-oversold days, real chains (A359 engine)
- A365 event-stack guard (vol backwardation + earnings) vs S159 conflict
- A366 50 % take vs hold on Jamie's own book
- A369 per-stock threshold lens for every threshold signal (IV, RSI, …) in fast_screen
- Candidates: earnings-crossing calls (all names), stacked put lanes + sector cap (A352), index-vs-single-stock IV spread, credit-wide as a put size dial