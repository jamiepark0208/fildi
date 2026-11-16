# S191 — Entry signals for buying and selling puts (screen)
**Ask (Jamie 11-15):** "0 bp depends on when you buy/close; find signals that improve the odds: overextended multiples, resistance zones, chart patterns/shapes, liquidity setups." Both directions (Jamie 11-15: "yes both").
**Stage:** screen (fast_screen pools: model-priced at the stock's own IV30, next-open entry, daily bars). A cell that passes goes to a full study on real quotes with an intraday entry candle (contract 8, 13). Nothing here is a trade verdict.
**Dupe check:** BOARD + INDEX read 11-15. S088 uses S/R zones to pick strikes, not as an entry trigger. S151 tests indicator turning points; it doesn't cover sweeps or patterns. S147 pattern lab = indicator context. S186 = sector falling knife. S160 = RSI dips. None tests sweeps, double tops/bottoms, rallies into resistance, or forward-P/E stretch as put entries.

## Pre-registration (written before any result)
**Regime (contract 12):** SPY close vs its 200-day SMA. Bull = above, bear = below. No calendar halves as the regime; fit (< 2025) / holdout (≥ 2025) is shown only as a stability check inside each regime.

**Signals (all use bars ≤ t; entry = next open; one event per ticker per 10 days):**
| id | side | rule |
|---|---|---|
| sweep_low_reclaim | bull | low < prior 20-day low, close back above it (failed breakdown, stops taken) |
| at_support | bull | close within 0.5 ATR above the t−60…t−6 swing low after a 10-day decline |
| double_bottom | bull | two lows (t−40…t−21, t−20…t−3) within 1 ATR, neckline ≥ 2 ATR above; close crosses above the neckline |
| val_cheap | bull | log forward P/E (IBES FY1 mean, 3-day lag) z < −2 vs own trailing 3 years, EPS > 0 |
| sweep_high_reject | bear | high > prior 20-day high, close back below it (failed breakout) |
| at_resistance | bear | close within 0.5 ATR below the t−60…t−6 swing high after a 10-day rally |
| double_top | bear | mirror of double_bottom; close crosses below the neckline |
| breakdown50 | bear | close crosses below the prior 50-day low |
| val_stretch | bear | log forward P/E z > +2 vs own trailing 3 years, EPS > 0 |

**Outcomes:** stock 5/10/21-day return vs same-day same-vol-decile peers (leave-one-out); short put 0.08Δ 14 DTE and 0.12Δ 25 DTE held to expiry (bp/wk of collateral, kept %, breach %) vs the same peers; long put 0.30Δ 30 DTE, half-DTE exit (return on debit) vs the same peers.

**Literature → expected sign per cell** (+ = signal beats peers for that trade):
- Lo-Mamaysky-Wang 2000 (JF): patterns shift return distributions a little; no proven profit after costs.
- Osler 2000/2003: S/R levels stop trends more than chance (FX), but breaks through levels accelerate.
- George-Hwang 2004: names near highs keep going, so resistance doesn't mean reversal in stocks.
- Bajgrowicz-Scaillet 2012: technical rules ≈ 0 after data-snooping corrections and costs.
- Jegadeesh 1990: 1–4 week reversal, which favours sweep-reclaim.
- Valuation predicts over years, not weeks (Campbell-Shiller); expect ≈ 0 at these horizons except stretched names in sell-offs.

| signal group | regime | sell put | long put |
|---|---|---|---|
| bull (sweep_low, support, double_bottom) | bull | **+** | − |
| bull | bear | 0 | 0 |
| val_cheap | bull | + (small) | − |
| val_cheap | bear | 0/− (value traps) | 0 |
| bear (sweep_high, resistance, double_top, breakdown) | bull | 0 | **0/−** (continuation) |
| bear | bear | **−** | **+** |
| val_stretch | bull | 0 | − (momentum carries) |
| val_stretch | bear | − | **+** |

**Pass bar (screen → full study):** in a regime cell, n_indep ≥ 30 (distinct ticker-weeks), peer excess has the pre-registered sign, month-clustered |t| ≥ 2, same sign in fit and holdout, and a one-day-delayed entry keeps the sign. Cells with n < 30 → "can't answer at this n".

## Results (11-15, screen)
**Goal moved: no** — screen only (model-priced pools, next-open entry, daily bars); nothing ships. Data: 938 tickers 2018-10 → 2026-11-05 (pools 2020-09 → 2026-10); bull 1,480 days, bear 356 days (≈ 21–26 bear months → bear cells are thin by month count). Causal check pass (AAPL/NVDA/JPM, 8 cuts). 108 cells tested → ≈ 5 would show |t| ≥ 2 by chance; 9 did, so trust only patterns that repeat across cells. Placebo = 100 within-ticker circular date shifts; t = month-clustered; excess = vs same-day same-vol-decile peers, same Δ/DTE.

**1. Sweep-and-reclaim of the 20-day low → better put sale (only signal that repeats; candidate).**
| cell | excess vs peers | pool base | t | fit / holdout / 1-day delay | placebo share |
|---|---|---|---|---|---|
| 0.12Δ 25 DTE, bull | +1.7 bp/wk (+11 %) | 14.7 | 2.2 | +1.6 / +1.7 / +2.0 | 0.01 |
| 0.12Δ 25 DTE, bear | +3.5 bp/wk (+18 %) | 19.7 | 2.4 | +2.5 / +6.3 / +1.8 | 0.03 |
| 0.08Δ 14 DTE, bear | +7.4 bp/wk (+39 %) | 19.2 | 2.9 | +6.3 / +10.7 / +2.7 | 0.01 |
| 0.08Δ 14 DTE, bull | +0.5 | 17.4 | 1.2 | — | — |
Breach rate 1–2 pp below peers. Pre-registered bull **+** ✓; bear pre-registered 0, came out + (stronger). Mechanism = Jegadeesh 1990 short-term reversal + stops cleared below the obvious low (Osler 2005).

**2. Support / resistance are NOT reversal levels in a bull market (continuation, George-Hwang 2004).**
- Rally into resistance → stock **beats** peers by +50 bp over 21 d (t 2.4, placebo 0.01). The bear call is wrong.
- Decline to support → stock **lags** peers by −57 bp (t −2.5). The bull call is wrong.
- Failed breakout (sweep-high-reject) → stock still beats peers over 10 d (t 2.1).
- Put P&L at support/resistance: no edge (|t| ≤ 1).
- Use: don't buy puts into resistance in an uptrend; "at support" is not a reason to sell a put.
- Bear regime: can't answer (t < 1.4, 25 months).

**3. Chart patterns (double top/bottom, 50-day breakdown):** no stock edge in either regime.
- Long 0.30Δ puts after a double-top break in a bull market lose 5.6 % more of the debit than peers (t −2.8): avoid.
- After a double bottom in a bear market, long puts lose 7.1 % more (t −2.8): the bottom pattern works as a "don't buy puts" flag.

**4. Valuation vs own 3-year forward P/E:**
- Cheap-vs-own-history in a bull market = **worse** put sale: −5.1 bp/wk vs peers on 0.12Δ (t −2.2, 221 events, placebo 0.04). Value trap: the estimate is falling, not the price lagging. Avoid flag.
- Stretched in a bear market (the put-buying idea): stock lags peers +1.5 % / +3.1 % at 5 / 21 d (t 2.0 / 1.7), but only **48 events in 16 months: can't answer at this n.** Needs ≥ 30 independent months, i.e. the next real sell-off, or IBES history before 2016.

**5. Long puts:** no signal makes long puts beat peers in either regime (consistent with BOARD: you pay the rich IV).

## Winner pass / next
- Sweep-reclaim goes to the full study:
  - Entry: the reclaim minute on 30m/5m bars (`quantcore.bars.load_intraday`, clean 250), skip the first 30–60 min.
  - Pricing: real quotes (LSEG surface; OPRA since 10/2025).
  - Comparators: the same name's any-day put and same-vol peers.
  - Stratify by IV÷RV (S059) and P(kept) tier, to check it adds to the live put score and isn't the same thing.
- Avoid flags (cheap-vs-own P/E in bull; double-top long puts) → shadow chips after the full study confirms them.
- The S/R continuation result is the key lesson for put buying: in an uptrend, bearish "levels" fail; put-buying signals should wait for the bear regime.
- Files: `scripts/watchlist_sync/analysis/s191_entry_signals.py`, `s191_placebo.py`; cells `research/studies/out/S191/cells.csv`.
