"""quantcore — the one home for shared quant logic (Jamie 11-15).

  ta     RSI / EMA / SMA / RMA / ATR, TradingView-exact, 1-D or (time, names) panels
  bs     Black-Scholes price / delta / IV, keyword-only, iv-as-fraction guard
  bars   intraday loader (RTH, ET session dates, invariants), splits from optlab.splits
  causal truncation look-ahead test for any series function

scripts/copy_ratchet.py blocks new copies of these outside quantcore (count may only fall).
"""
