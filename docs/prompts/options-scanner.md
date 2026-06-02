# Options Scanner — build spec

## Problem
I have 31+ watchlisted tickers. To find the best put to sell I open Robinhood, click each stock one by one, navigate to options, find a viable strike, memorize it, go back, repeat. No way to compare across stocks. This tab replaces that — one page, all tickers, all viable strikes, scannable in 60 seconds.

## Design pattern
One expandable accordion row per ticker. Exclude red-tagged tickers entirely.

### Collapsed row (zero API calls — use existing scorecard batch data)
- Left border = watchlist tag color (blue=#378ADD, green=#1D9E75, yellow=#EF9F27, purple=#7F77DD)
- Ticker + price + signal badge + composite score + IV rank
- Strike summary: "3 strikes · best 1.04%/wk" or "excluded · RM filter"
- Expand chevron + per-row refresh icon (refreshes that ticker only)

### Expanded row (lazy fetch on first expand only)
- Fetch /api/options/:ticker on first expand, cache in component state
- Never re-fetch on collapse/re-expand unless per-row refresh clicked
- Viable strike cards only (>=0.5%/wk, 1wk + 2wk expiries only)
- One-line reasoning computed client-side from cached data — zero extra API call:
  - GO: "RSI 38.2 / 42, MFI 19.4 / 25, down 8.3% vs SPY — IV 74%"
  - WATCH: "MFI 27.4 slightly above 25 — monitor for weakening"
  - NO/RM: "Up +23.2% in 5 days — wait for mean reversion"
  - NO: "RSI 63.4 above threshold 43"

### Strike cards
- Show: expiry label (Jun 6 · 1wk), strike price, income%/wk, OTM%, IV
- Best card highlighted (highest income% meeting tier OTM minimum)
- Income color: >=1.0% success green · 0.7-1.0% amber · 0.5-0.7% muted
- No viable strikes: show reason text, not blank

### Sorting (toggle buttons, top of page)
Default: income%/wk descending. Also: score, IV rank, OTM buffer, signal.

### Filter chips (top of page)
[1wk] on · [2wk] on · [GO only] off · [>=0.5%/wk] on

### Color legend
One line below page title showing blue/green/yellow/purple meanings.

## Data rules — strictly enforced
| Trigger | API calls |
|---|---|
| Tab load | 1 — scorecard batch only |
| Row expand (first) | 1 — /api/options/:ticker |
| Row expand (repeat) | 0 — from cache |
| Per-row refresh | 1 — that ticker only |
| Global refresh | 1 — scorecard batch only |
| Tab revisit | 0 — from state |

- Reuse daily summary store for VIX + earnings dates — do not re-fetch
- Show "last updated X min ago" next to global refresh button
- Never auto-refresh or poll

## Constraints
- Do not modify scoring, RSI/MFI thresholds, signal logic, or options calculations
- Do not rebuild any component that already exists
- Narrow options slice only — existing /api/options/:ticker already handles this

## Verification after build
1. Tab load = exactly 1 API call
2. First row expand = exactly 1 API call
3. Second expand same row = 0 calls
4. Global refresh = 1 call not 31
Then run verifier agent.
