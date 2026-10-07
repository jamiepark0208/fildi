# S011 — Does the trader's entry timing work?
2026-10-06 · **display (setup tag) · open** · `scripts/watchlist_sync/analysis/timing_rh_trades.py` · full tables `out/timing/report.md`

## Question
The trader sells puts after a sharp drop / near support / intraday-low RSI, and calls after a decent rally, so strikes land in their
favour. Does that beat selling the same strikes on any other day?

## Data
Robinhood filled sell-to-open orders 2026-01-21 → 10-06, deduped by order_id: 1,536 filled (85% of 1,808 placed), 1,513 with prices on
both ends (949 puts, 564 calls). IRA `772445425` (the strategy, 1,057) and FILDI `5QU47796` (456). Daily closes `prices_historical`.

## Method
- Setup measured at the close **before** entry (no look-ahead): 5-day return, RSI(14), distance above the 20-day low.
- Outcome: stock beyond the strike at the expiry close ("breach" = ITM; ignores early closes), P&L at expiry ÷ collateral.
- Baseline: same ticker, same OTM %, same holding days, every 2026 trading day (METHODS #5).
- Robustness: halves (Jan–May / Jun–Oct); bootstrap clustered by (ticker, week), 1,000 draws (METHODS #7).

## Result (all accounts)
| Setup | Trades | Breach | Random-day breach | P&L ÷ collateral |
|---|---|---|---|---|
| Put after 5-day drop 3–8% | 184 | 17.4% | 18.4% | +0.50% |
| Put after 5-day drop ≥ 8% | 384 | 17.2% | 19.5% | +0.55% |
| Put, no dip | 381 | **26.5%** | 19.1% | −0.07% |
| Put within 3% of 20-day low | 168 | 15.5% | 23.3% | +0.68% |
| Put > 10% above 20-day low | 452 | 25.2% | 16.1% | +0.04% |
| Call after rally ≥ 3% (pooled) | 227 | ~10% | — | — |
| Call, no rally | 337 | ~20% | — | — |

Dip-or-support puts vs no-dip: P&L +0.56 pt (95% CI −0.14..+1.48), breach edge +7.2 pt; H1 +0.16 pt, H2 +1.26 pt (same sign).
Rally calls vs no rally: P&L +0.52 pt (CI −0.32..+1.35), breach edge +14.5 pt; same sign both halves. IRA alone: no-dip puts 21% vs 17%.

## Verdict
The trader's discretionary timing shows up in the data, consistently in direction. It is **not yet significant on P&L** (CIs cross 0;
229 put clusters). This differs from S004 ("oversold no edge") because S004 ranked RSI across the whole universe; S011 is this trader's
own names, strikes and judgement. Both can be true.

## Decision (user YES 2026-10-06)
Display-only setup tag on Model List put/call ideas (`scripts/watchlist_sync/setup.py`: dip = 5d ≤ −3% or ≤ 3% above the 20-day low;
rally = 5d ≥ +3%). Never filters or re-ranks. `trader-context.md` notes timing as the trader's edge to track.

## Caveats / re-test
One year, mostly an up-trending market; trades cluster in a few names (HOOD, AAOI, RDDT…). Re-run after ≥ 100 new trades
(`timing_rh_trades.py`, ~10 s). Promote to a score input only if the same sign holds and the clustered CI excludes 0.
