# S012 — Robinhood strategy review: what it is, is it viable, how verify should price contracts
2026-10-06 · **adopted** · scripts: `wheel.py`, `analysis/grade_rh_trades.py`, `verify_plan.py`, `rebalance.py` · related S011, S013

## Strategy profile (sell-to-open fills 2026-01 → 10)
- Weekly high-IV wheel: 1,537 STO (965 puts, 572 calls); DTE median 4 (72% ≤ 7d); median 11% OTM; median 1.33%/week of strike.
- Concentrated: top 6 names (HOOD, AAOI, RDDT, POET, PLTR, OPEN) ≈ 68% of put collateral. ~60% closed early.
- Two accounts: **IRA = the strategy** (judge the model here); **FILDI = mixed** (stocks, option-income ETFs HOOY/NVDY, crypto,
  prediction markets) with a margin loan.

## Returns
Wheel P&L ≈ **+$40.4k** = options +$18.1k + stock realized +$17.6k + unrealized +$1.5k (+ dividends). **HOOD +$21.2k** (stock bought in
the Feb dip); ex-HOOD ≈ +$19k. Losers once stock is counted: OPEN −$5.4k (options +$2.3k, stock −$7.7k), USAR −$2.1k, LDI, REBN, ALOY.
Calls +$1.4k over 322 trades; Apr–Jun calls lost ~$3.8k on rebounds. Benchmarks YTD: SPY +13.4%, QQQ +22.3%. Deposits unknown → % return
not exact.

## Viability
Harvests the variance risk premium: Cboe PUT/WPUT ≈ S&P return at lower vol (2006–15 Sharpe 0.50–0.52 vs 0.46, WPUT max DD −24% vs
−51%). Single-stock premia are thinner; our backtests say the average sold option ≈ break-even (S005), so the edge is **selection**
(ownership factors) and **timing** (S011). Weeklies on speculative names add gap/earnings risk none of the published versions take.
Who else: r/thetagang wheel traders; tastytrade (45 DTE, manage at 50% / 21 DTE beats holding); index put-write funds; vol desks.
Public code to borrow: optopsy (chain backtests), QuantConnect LEAN, Alphalens (factor tear sheets), NewWheel ("Claude proposes,
Python decides" — our split).

## Verify pricing (29 checked contracts, plans 2–3)
| Fact | Evidence |
|---|---|
| Fildi premium = chain **bid** (Schwab, Yahoo fallback), not mid | `schwab-client.ts` incomePct on bid; `model-track-record.ts` grades on bid |
| RH realistic fill (`high_fill_rate_sell_price`) = bid + 10–36% of the spread, median ~23% | stored RH quotes |
| Big Fildi↔RH gaps (−74% … +68%) = stale overnight plan price + spot moves, not mid vs bid | plan 2 vs plan 3 quotes |
| Spread blocks (12/29) came from quotes at the close; in session spreads tightened (MNDY $1.15/2.25 → $1.00/1.20) | plans 2, 3 |
| Premium-gap check is warn-only; blocks are spread, yield at the realistic fill, liquidity, OTM/delta, freshness | `verify_plan.evaluate_option` |

## Decisions (user YES 2026-10-06)
1. **Spread rule** (`rules.py`): block only in session when spread > 75% of mark **and** > $0.10 wide; 30–75% → warning with a
   suggested limit (bid + 25% of spread); after-hours → warning. Before/after on the 29: spread blocks 12 → 3 (BEAM 88%, ETSY 94%,
   TPG 111%, all at the close); TPG in session 73% now passes with a warning.
2. **Schwab re-price at verify**: `POST /api/schwab/option-quotes` (localhost, 1 call / 50 contracts) → the premium-gap check compares
   the RH fill to Schwab at the same convention and moment. Tested 13/13 contracts.
3. **Chain history**: `option_chain_history` saved from the chains the nightly option-score job already fetches (0 extra calls); OTM
   1–35%, live bid, ≤ 45 DTE; fields bid, ask, last, iv, delta, volume, OI, spot, source.
4. **Margin rule** (`params portfolio.no_new_puts_on_margin`): an account with a margin loan gets no new put ideas (FILDI today).
5. **FILDI rebalance folder** (Model List, display only, `rebalance.py`): per-name cap 15% of net, speculative single stocks ≤ 40% of
   holdings, leverage, crypto share. 10/06: 1.61× leverage, margin $20.3k; trims HOOY $11.1k, USAR $6.0k, NVDY $3.5k ≈ the loan.
6. **Setup tag** (S011) and **block audit** (S013).

## Caveats / re-test
Realized P&L since 2025 only; deposits unknown; 10/06 export dropped Avg Cost / avg premium / delta (carried forward). Re-run
`wheel.py` and `grade_rh_trades.py` monthly; revisit spread thresholds when S013 has ≥ 30 rows per check.
