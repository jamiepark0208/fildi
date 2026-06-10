---
name: options-pricer
description: Narrow options chain fetch. Given stock price, find weekly put strike where premium/strike >= 0.8%. NOT a full chain dump.
---

What we fetch (minimal slice only):
  - Nearest weekly expiry (fallback: 2-week)
  - Strike window: spot*(1-maxOTM) to spot*(1-minOTM)
  - Result: 5-15 rows, not 200+
  - Fields kept: strike, bid, ask, lastPrice, impliedVolatility, volume
  - Fields dropped: everything else

Income gate calculation:
  income_pct = (premium / strike) * 100
  Target: T1 >= 0.8%, T2 >= 1.0%, T3 >= 1.2%
  If using 2-week expiry: divide income_pct by 2 for weekly equivalent

Cache:
  Key: options:{ticker}:{expiry_date}  TTL: 300s
  Invalidate at 4pm ET daily (bid/ask goes stale after close)

Stock signals come from stock layer, not options layer:
  RSI, MFI, 5-day return, current price fetched separately via yfinance
