---
name: yahoo-finance2 v3 options chain
description: How to call yahooFinance.options() in v3, and what to expect from the data.
---

**Rule:** yahoo-finance2 v3 requires `{ validateResult: false }` as the third argument to avoid schema validation errors.

```typescript
const raw = await yahooFinance.options(ticker, { date }, { validateResult: false });
```

**Data shape:** `raw.options[0].puts` and `raw.options[0].calls` are arrays of contracts. `raw.quote.regularMarketPrice` is the spot price. `bid`, `ask`, `lastPrice`, `impliedVolatility` can all be `null` when the market is closed or the contract has no recent trades.

**Why:** Yahoo Finance's schema changes frequently; strict validation breaks. Null IV is normal outside market hours — the Black-Scholes Greeks will be null in that case too.

**How to apply:** Always pass `{ validateResult: false }` as the options arg. Handle null IV gracefully in the frontend (show DTE fallback when Greeks aren't available).
