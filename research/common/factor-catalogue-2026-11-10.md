# Factor catalogue for short puts: many factors, ranked, tested together (Claude 2026-11-10)

> Jamie 11-10: "you both are simply thinking of a few factors … think of several many more factors, then rank which one is best
> and why, then start to test many different factors." Answer: 46 factors run through one screen (S187), plus about 30 more that
> can't be tested on our data yet, each with the reason. Run: `scripts/watchlist_sync/analysis/s187_factor_screen.py` → `out/studies/S187.md`.

**Goal moved: no.** After the multiple-testing correction, 1 of 46 factors passes and it is already live (vol-of-vol, inside put_edge).
Two pre-registered factors hold out of sample and add to put_edge, but they missed the train bar: a stock's own past put record
(option momentum, Heston et al. 2023). Those are the next test.

## 1. How the screen works (one harness, every factor treated the same)

- **Trades:** 70,390 simulated weekly ~1σ puts, 242 names, 2020-02 → 2026-10, net of fill (bid + 23 % of spread). Same harness as S045/S059.
- **Four outcomes per trade:** net P&L · breach · **stock part** (short-put delta × stock move) · **vol part** (P&L minus stock part). The last
  two split every short put into its two bets (G1).
- **Test:** weekly cross-sectional rank IC, controlling for IV/RV, IV level and earnings-in-window (the factors we already use).
  Expected sign written in the script **before** the run.
- **Pass bar:** Benjamini-Hochberg q 0.10 across 92 tests, |t| ≥ 3, same sign in both train halves, sign = registered. Selection
  uses train weeks before 2024-07 (230 weeks: 153 up / 77 down). Then holdout 2024-07 → (118 weeks), then marginal over put_edge.
- **Regime (rule 12, causal):** up = SPY above its 200-day average and up over 63 days; down = otherwise. Both cells ≥ 30 weeks for
  every factor except the 8-K / Form-4 ones (data from 2022).

## 2. Ranking rubric (why one factor beats another)

Each factor gets 0–2 on six questions. Rank = sum. Honest caveat: the expected signs were fixed before the run, but the prior scores below were written up after it, so treat them as a reading guide, not a pre-registration. The screen's t-stats are the ranking that counts.
1. **Mechanism:** a named reason a put seller gets paid or hurt (risk premium, demand pressure, slow reaction)?
2. **Published prior:** peer-reviewed, replicated, survives costs?
3. **Independent of what we use:** low overlap with IV/RV, IV level, vol-of-vol, trend?
4. **Data in hand:** history ≥ 5 years, point-in-time, our names?
5. **Reach:** how many of Jamie's weekly candidates it changes?
6. **Our own evidence:** untested (2) · tested once with a framing problem (1) · tested well and dead (0).

## 3. The catalogue: tested in S187 (train IC t on net P&L; + = better for the seller)

| Family | Factor | Why it could matter (source) | Prior score | S187 result |
|---|---|---|---|---|
| Option price | vol-of-vol | IV that swings is overpriced (Cao, Vasquez, Xiao, Zhan) | 9 | **t +4.5, holdout +3.9; vol part +6.5. Already in put_edge (adds 0 beyond it)** |
| Option price | own past put P&L, 52 w (option momentum) | Options that lost for sellers keep losing (Heston, Jones, Khorram, Li, Mo, JF 2023) | 10 | train +1.7; **down cell +0.035 t +2.8; holdout t +2.0, +1.9 over put_edge** |
| Option price | own past breach rate, 52 w | same mechanism, breach side | 9 | train −0.8; **down cell t −2.5; holdout t −2.4, −2.5 over put_edge** |
| Option price | IV change 5 d | IV spikes overshoot (Stein 1989; Goyal-Saretto) | 8 | +2.5, up cell only (+2.9) |
| Option price | IV change 21 d · IV percentile 1 y | same | 7 | +0.8 · +0.6 |
| Option price | term slope 30–90 | inverted = short-dated rich (Vasquez 2017) | 8 | +0.2 (dead again, S059) |
| Option price | HAR-RV ÷ IV (S033) | better RV forecast → better richness read (Corsi 2009) | 8 | −0.2. Adds nothing once IV/RV is controlled |
| Option price | IV minus SPY IV | correlation premium (Driessen et al. 2009) | 6 | — (collinear with IV level control) |
| Stock | volume 5 d ÷ 60 d | volume spike = information arriving | 7 | **−4.1, breach +4.1 train; fails holdout (−1.2)** |
| Stock | 1-month return · 5-day return · RSI · place in 21-d range | short-term reversal (Jegadeesh 1990, Lehmann 1990) | 7 | −2.5 · −1.9 · −2.0 · −1.9 (right sign, under bar) |
| Stock | distance to 50-d average | short-term reversal | 5 | −2.6 |
| Stock | 12-1 momentum · 52-w-high distance · distance to 200-d | momentum (Jegadeesh-Titman; George-Hwang 2004) | 8 | +0.7 · −0.6 · −0.4; stock part +2.0 / +1.9 / +1.8 but the vol part cancels it |
| Stock | MAX daily return 21 d · worst day 21 d | lottery stocks drift down (Bali, Cakici, Whitelaw 2011) | 8 | −0.9 · −1.8 |
| Stock | beta | low-beta anomaly; bear losses | 6 | +1.3 |
| Stock | log price · log $ volume | low-priced / illiquid names drift (Chan 2003) | 5 | −0.8 · −1.0 |
| Tail | idio vol | options richer (Cao-Han 2013), stock drifts down | 8 | −0.7. **Vol part +1.4, stock part −1.8: the two bets do pull apart (G1 sign right), each too weak to act on** |
| Tail | realised skew 60 d · jump count 252 d · gap count 63 d · range spike | jump risk under-priced (Amaya et al. 2015) | 7 | −0.0 · +0.3 · +1.7 · −1.4 |
| Tail | days since last earnings | post-event IV crush | 6 | **−4.4, both halves, both regimes, holdout −2.3. Registered sign was +, so it's an unregistered finding. Not monotone (0–45 d: +3.4 → −7.4 bp/wk, 60–75 d: +16/+22 bp, n small). Likely an artifact: the sim prices every week at IV30, which still holds the earnings premium. Needs real weekly quotes.** |
| Tail | past earnings move ÷ IV | jumpy reporters | 7 | −1.5 |
| Positioning | short interest days-to-cover · 3-month SI change | shorts informed (Boehmer, Jones, Zhang 2008; Rapach et al. 2016) | 8 | −1.8 · −0.9 (down cell −2.0) |
| Positioning | insider buys 90 d · sells 90 d | opportunistic insiders (Cohen, Malloy, Pomorski 2012) | 7 | −1.3 · −0.2 (2022→ only, 66/50 weeks) |
| Events | financing 8-K 30 d · risk 8-K 30 d · any 8-K 5 d | dilution; news vs no-news drops (Chan 2003; Loughran-Ritter 1995) | 7 | −1.0 · −0.7 · −1.7 (2022→ only) |
| Analysts | forward EPS growth · dispersion · revisions · SUE · coverage · StarMine alpha | expectations drift (Diether-Malloy-Scherbina 2002; PEAD) | 6 | +2.5 · −2.0 · −0.9 · +0.5 · 0.0 · +0.1. **SUE and 3-m revisions: stock part +2.3/+2.6, vol part −3.5/−2.9 → cancel** |

## 4. Not testable in this harness, and why (ranked by prior × reach)

| Rank | Factor | Why it matters | Blocker | What unblocks it |
|---|---|---|---|---|
| 1 | Real put skew / 25Δ risk reversal (Xing-Zhang-Zhao 2010) | steep smirk → stock drifts down AND put richer, both priced at the strike | rr25 history = 22 days (option_chain_history + skew_survey, 2026-10 →); LSEG put IV = call IV | ~6 months of daily skew_survey → weekly cross-section test |
| 2 | Customer order imbalance (Muravyev 2016) | strongest single predictor of option returns in the literature | OPRA trades via LSE only since 10/2025, unsigned | sign by quote rule on LSE OPRA; 13 months = bull cell only |
| 3 | Earnings window: sell −5…−1 d vs print day vs +1 d, implied vs own move (Gao-Xing-Zhang 2018) | 45 % of missed trades are earnings blocks | sim prices at IV30, so no event IV crush | real chains around prints (option_chain_history, LSEG daily marks) = G3 study |
| 4 | Strike vs support (prior lows, volume nodes, round numbers) | Jamie's style; practitioner | `sr_cushion` exists in S045, not yet in the screen | add to S187 v2 (cheap) |
| 5 | Sector-relative move, sector ETF trend | stock-specific vs sector dislocation (Codex lane 1) | ticker → ETF map not joined in the harness | join `sector_etfs.py` map (cheap) |
| 6 | Intraday entry state (distance from running low, reclaim, relative volume) | Jamie's entry style | 1-minute bars: 54 names since 08-19 locally; LSE 1m history not pulled | Codex smoke (A370) → LSE 1m for bear tapes |
| 7 | News sentiment / no-news drop (Chan 2003; Tetlock 2007) | news drops drift, no-news drops revert | media_sentiment_daily since 10-22 only | 8-K proxy tested above (weak); needs a news archive |
| 8 | Institutional holdings change (13F), ETF ownership crowding | forced selling in drawdowns | holders_top = one snapshot | WRDS 13F history |
| 9 | Dilution capacity (S-3 shelf, ATM program, cash runway) for loss-makers | spec names fall on raises | 8-K "capital_and_financing" is only a proxy | EDGAR S-3/424B5 parse |
| 10 | Borrow fee / utilisation | hard-to-borrow names are overpriced and puts expensive | no data | vendor (paid) |
| 11 | Dealer gamma / open-interest pinning | gamma-driven moves near large-OI strikes | OI history thin | option_chain_history accrual |
| 12 | Market dispersion / implied correlation | index-vs-single-name premium (BOARD candidate) | needs index + component IV daily | LSEG daily (have SPY IV + names) → buildable |

## 5. What the screen says, in plain words

1. **Fundamental and momentum factors cancel inside a short put.** Good-news names (SUE, revisions, 12-1 momentum) rise more
   (stock part t +2 to +2.6), but their options are cheaper relative to what happens (vol part t −2 to −3.5). Net ≈ 0. That is why
   ~15 earlier "does fundamental X help puts?" tests came back dead. Those factors belong to the **stock/call** side, or to a put
   plus a hedge, not to put ranking.
2. **What pays the put seller is on the option side:** vol-of-vol (in), and possibly a name's own recent put record in down
   markets (next test). Of the stock-side factors only short-term reversal shows the registered sign, and it's weak.
3. **G1 (my idio-vol claim) is answered: no lever.** The two bets move in the registered directions, each at |t| < 2.
4. **The harness is the ceiling.** It prices every strike at IV30, so skew, term structure, earnings crush and order flow can't
   show up. The next big gains need real quotes (§ 4 rows 1–3), not more factors on the simulator.

## 6. Next tests, in order

1. **Option momentum (own past put P&L and breach rate) in down tape.** Registered now: down-cell IC > 0 for past P&L, < 0 for
   breach rate, both after put_edge. The 2024-07 → holdout is now inspected, so it no longer counts as fresh. Confirmation has
   to come from a different pricing source (LSEG daily real marks, 2020 →, ~120 names) and from forward weeks logged from today.
   Fold into the put_edge row if it holds; no new Ideas row (cap).
2. **S187 v2:** add strike-vs-support, sector-relative move, market dispersion (cheap joins); re-run under the same family + BH rule.
3. **G3 earnings window on real quotes** (the days-since-earnings artifact makes this more urgent).
4. Codex A370 intraday smoke (stock-side entry state), as agreed.
