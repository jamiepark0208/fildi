# live-intraday-monitor

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P0 |
| **Area** | fullstack (backend service + new page) |
| **Effort** | XL |
| **Created** | 2026-07-14 |
| **Source** | user workflow analysis — brainstorm session 2026-07-14 |
| **Related** | [options-scanner](../enhancements/33-csp-momentum-backtest-learning-research-070926.md) (scoring overlap), [portfolio-improvements](../enhancements/8-portfolio-analysis-improvements-070926.md) (position data), [daily-brief](../enhancements/9-portfolio-daily-brief-improvements-070926.md) (market context overlap) |
| **Type** | NEW (new `/live` route, new backend services, new data pipeline) |
| **Impl research** | 2026-07-14 deep — TradingView integration research, reversal detection algorithms, streaming TA libraries, Finnhub WebSocket capabilities |

### Purpose

Unify the user's daily put-selling workflow — currently split across TradingView (chart-based reversal signals), FILDI Options Scanner (strike selection), Portfolio tab (position tracking), and external news sources — into one real-time surface that answers: **"Which puts should I sell right now, and is the timing right?"**

### User workflow being automated

The user's daily loop (captured from detailed workflow interview):

1. **Market context** — Pre-market: check news, top movers, sector flows, macro events to understand "what kind of day is it." Example: tariff reinstatement → sell-off → reversal next day.
2. **Position RV analysis** — Check open short options. If a position has earned 30-60% of target 1%/week income in 1-2 days, close early and redeploy capital. This is "relative value rotation."
3. **New entry selection** — Find the best put to sell by combining: (a) Options Scanner rankings, (b) day-over-day price drop magnitude, (c) intraday RSI/momentum reversal signals, (d) news context for *why* the stock moved (tariff rotation = good, bankruptcy = bad).
4. **Repeat throughout the session** — This isn't a single morning scan; it's a continuous loop as positions hit capture thresholds and new opportunities emerge from intraday moves.

**Key user-acknowledged weakness:** Tendency to chase falling knives — entering on the first oversold reading without waiting for exhaustion confirmation. The Live tab's state machine exists specifically to impose discipline here.

### Relationship to existing tabs

- **Options Scanner** answers "what are the best strikes to sell?" — the Live tab does NOT replace this. Live answers "which of those scanner candidates have favorable *intraday timing* right now?"
- **Portfolio** shows position history/P&L — Live surfaces a compact "close alert" for positions nearing capture threshold, not a full portfolio view.
- **Technical Scorecard** shows daily-timeframe indicators — Live shows intraday 5-min indicators for real-time timing.

### Cache / DB compliance

**New runtime services (in-memory, no DB writes during market hours):**
- Finnhub WebSocket connection → tick stream → in-memory candle buffer (~3KB per ticker × 25 tickers = ~75KB total)
- Streaming indicator state objects (~1KB per ticker per indicator, ~150KB total)
- Hot list derived from existing scanner cache (no new DB query pattern)

**New API calls:**
- Finnhub WebSocket: free tier, 50-symbol cap, no rate limit on incoming messages
- Finnhub REST for 5-min history warmup: ~25 calls at market open (within 60/min free limit)
- Finnhub company news: 1 call per ticker, cached 15 min in TTLCache

**No new DB tables in v1.** All live state is ephemeral/in-memory. Scanner rankings read from existing cache. Portfolio positions read from existing `portfolioOptions` table.

---

## 1. Executive summary

**Three panels on a new `/live` page:**

1. **Market Context Bar** (top strip) — Live SPY/QQQ/VIX/10Y + macro regime badge + session clock
2. **Position Alerts** (compact) — Open short options from last portfolio CSV, with estimated "% of premium captured," highlighting positions that have hit the 30-60% capture threshold
3. **Opportunities Table** (main) — Hot-list tickers from scanner rankings, enriched with intraday price movement, streaming technical signals, a composite "entry readiness" score, and a 1-line news headline for context

Each opportunity ticker has a **state machine** (READY / DEVELOPING / WATCHING / CAUTION) that enforces the user's discipline around not entering falling knives.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Workflow fragmented across 4+ tools | User interview: TradingView for charts, Scanner for strikes, Portfolio for positions, external news — context-switching loses time during fast markets |
| No intraday technical signals in FILDI | `indicators.ts` computes RSI/MACD/Stoch on daily OHLCV only; `computeIndicators()` L78 uses `pricesHistorical` (daily bars). No 5-min candle infrastructure exists |
| Falling knife risk | User self-identified: "I frequently make errors by chasing a falling knife." No systematic exhaustion-confirmation gate exists |
| RV rotation requires mental math | User manually estimates "have I earned 30-60% of 1%/week?" — no automated capture-threshold flagging |
| Scanner rankings exist but lack timing context | `OptionsScanner` shows GO/WATCH signals + best strikes, but can't answer "is *right now* a good time to enter this ticker?" |
| No top-movers surface for put-selling universe | No existing page shows day-over-day movers filtered to the user's watchlist/scanner universe |

---

## 3. What (build scope)

### In scope

| # | Work | Phase |
|---|---|---|
| W1 | Finnhub WebSocket connection manager (`lib/finnhub-ws.ts`) — connect, subscribe, unsubscribe, auto-reconnect, heartbeat | P1 |
| W2 | Candle aggregator (`lib/candle-aggregator.ts`) — tick → 5-min OHLCV builder with session-anchored VWAP accumulator | P1 |
| W3 | Hot list manager (`lib/live-hotlist.ts`) — derive unique tickers from scanner rankings (top 10 per sort order: `optionScore`, `score`, `income`, `iv`, `buffer` — the `SortKey` type in `options-scanner.tsx` L63), deduplicate, always include SPY/QQQ/VIX/^TNX. Refresh every 15 min during market hours | P1 |
| W4 | Streaming TA engine (`lib/live-signals.ts`) — per-ticker indicator instances using `trading-signals` library, composite scoring, state machine. See §4.3 for indicator details | P2 |
| W5 | Intraday warmup — Fetch 78 bars of 5-min history from Finnhub REST at session start to seed indicators | P2 |
| W6 | Time-of-day volume normalization — 5-day rolling avg volume profile by 5-min bucket, stored in memory, rebuilt daily | P2 |
| W7 | API routes: `GET /api/live/state` (snapshot), `GET /api/live/stream` (SSE), `GET /api/live/news/:ticker` (Finnhub company news, TTLCache 15 min) | P3 |
| W8 | Position alert computation — filter `portfolioOptions` for `direction='short'` + not expired, compute `% captured = (avgPremium - currentMid) / avgPremium` | P3 |
| W9 | Frontend: `pages/live.tsx` — three-panel layout with SSE subscription, market context bar, position alerts, opportunities table | P4 |
| W10 | Frontend: click-to-expand detail — mini `LightweightPriceChart` with BB/VWAP overlay, signal breakdown, inline scanner strikes | P5 |
| W11 | Sector exposure warning — when viewing an opportunity, show "You have N positions in {sector}" if applicable | P5 |

### Out of scope

| Item | Reason |
|---|---|
| Sell-calls management | Per-ticker, subjective — user explicitly deferred to separate task |
| Long calls alerts | Rare (outlier-only); user buys calls manually based on conviction |
| TradingView webhook integration | Evaluated and rejected for v1: 40-symbol Pine Script cap, alert limits (20 on Essential), HTTPS tunnel requirement, no delivery guarantee. Revisit as a later enhancement |
| Auto-trading / order execution | Display and suggestion only — user executes on Robinhood manually |
| Robinhood API integration | User prefers manual CSV export; no agentic brokerage hookup |
| New DB tables | All live state is ephemeral. Historical signal tracking is a future enhancement |
| Replacing Options Scanner | Live complements Scanner; Scanner owns strike selection, Live owns timing |

---

## 4. Implementation research pack

### 4.1 Existing code to reuse (do NOT rebuild)

| Component | Location | Reuse how |
|---|---|---|
| `IndicatorResult` interface | `api-server/src/lib/indicators.ts` L11-36 | Reference for field naming consistency; do not couple live signals to this daily-batch type — define a new `LiveSignal` interface |
| `computeIndicators()` | `api-server/src/lib/indicators.ts` L78 | **Do not reuse** — this recomputes from full arrays each call. Live engine needs streaming/incremental updates |
| `technicalindicators` library | Already installed, used by `indicators.ts` | **Do not use for live engine** — batch-only, O(n) per call. Use `trading-signals` instead for O(1) incremental `add()` |
| `computeFromOHLCV()` | `api-server/src/lib/technicals-db.ts` L71+ | Reference for BB width, volume ratio, realized vol formulas. Some math can be ported to streaming equivalents |
| `LightweightPriceChart` | `stock-compare/src/components/price-chart.tsx` L113 | Reuse directly for mini-chart in expanded detail view (already supports markers, price lines, EMA overlays) |
| `MarketChip` | `stock-compare/src/components/daily-brief.tsx` L42 | Reuse/extend for market context bar (already renders SPY/QQQ/VIX/10Y with color-coded change %) |
| `NewsCard` / `NewsItem` | `stock-compare/src/components/news-card.tsx` | Reuse for 1-line news headline display |
| `SortKey` type | `stock-compare/src/pages/options-scanner.tsx` L63 | Defines the 5 sort orders: `"optionScore" \| "score" \| "income" \| "iv" \| "buffer"` |
| `ParsedOption` | `api-server/src/lib/portfolio-parser.ts` L71-96 | Has `direction`, `optionType`, `strike`, `expiration`, `avgPremium`, `markPrice`, `unrealizedPnL`, `pnlPct` — everything needed for position alerts |
| `TTLCache` | `api-server/src/lib/ttl-cache.ts` | Use for Finnhub news caching (15 min TTL) |
| `TopNav` / `LEFT_NAV_ITEMS` | `stock-compare/src/components/top-nav.tsx` L21-30 | Add new nav item `{ id: "live", href: "/live", label: "Live", icon: Activity }` |
| `TOPNAV_H` | `stock-compare/src/components/top-nav.tsx` L11 | 56px — use for `pt-14` on live page |

### 4.2 New dependency

```
npm install trading-signals
```

**Why not reuse `technicalindicators` (already installed)?**
`technicalindicators` is a batch library — every call to `RSI.calculate({ values: [...] })` recomputes from the full array. For live streaming (new candle every 5 min × 25 tickers = 325 indicator updates/hour), this means O(n) recomputation each time, where n grows throughout the session. `trading-signals` supports incremental `add(closePrice)` which updates the indicator state in O(1) — the correct architecture for real-time streaming.

```typescript
import { RSI, MACD, BollingerBands, StochasticRSI } from 'trading-signals';

const rsi = new RSI(14);
rsi.add(closePrice);          // O(1) incremental update
const value = rsi.getResult(); // current RSI value

// Warmup: feed 78 historical bars via add() at startup
// Then feed each new 5-min candle close as it completes
```

### 4.3 Streaming TA engine design

**Indicators computed per ticker (on each closed 5-min candle):**

| Indicator | Library | Warmup bars | Purpose |
|---|---|---|---|
| RSI(14) | `trading-signals` | 15 | Oversold detection, divergence |
| MACD(12,26,9) histogram | `trading-signals` | 35 | Momentum shift / histogram turn |
| Stochastic(14,3) | `trading-signals` | 17 | Cycle timing, oversold bounce |
| Bollinger Bands(20,2) | `trading-signals` | 20 | Squeeze detection, band touch |
| VWAP | Custom (trivial) | 0 (session-anchored) | Institutional reference, reversion target |
| Relative Volume | Custom | 20 bars | Volume exhaustion / climax detection |

**All indicators fully operational after 35 bars of 5-min data = ~3 hours from market open, or immediately if seeded with 78-bar warmup at 9:30 AM.**

**Divergence detection (custom, ~50 lines):**
Track swing lows in both price and RSI over a 20-bar lookback window. Bullish divergence = price makes a lower low but RSI makes a higher low. This is the strongest single reversal indicator (~62-65% win rate when combined with volume confirmation) and is not provided by any TA library — must be implemented as a custom comparator on top of `trading-signals` RSI output.

**Composite entry readiness score (0-100):**

| Signal | Weight | Score | Rationale |
|---|---|---|---|
| RSI divergence detected | 25% | 0 or 100 (binary) | Most reliable reversal signal; prevents entering on "oversold but still falling" |
| MACD histogram turn (was negative-decreasing, now negative-increasing) | 20% | 0 or 100 (binary) | Confirms momentum shift |
| Volume exhaustion (spike > 2x avg on down candle, followed by declining volume) | 20% | 0-100 (scaled by spike magnitude) | Marks selling climax — strongest confirmation |
| Stochastic %K cross above %D from below 20 | 15% | 0 or 100 (binary) | Classic oversold bounce |
| Bollinger lower band touch + rejection candle | 10% | 0 or 100 (binary) | Mean reversion |
| VWAP reversion (price returning to VWAP after > 1 ATR deviation) | 10% | 0-100 (scaled by deviation distance) | Institutional anchor |

**Why these weights:** The user's primary risk is entering on a falling knife. RSI divergence (25%) and volume exhaustion (20%) are weighted highest because they specifically detect exhaustion *before* the actual reversal — they answer "has the selling stopped?" rather than just "is the stock down a lot?" MACD histogram turn (20%) confirms momentum is shifting. The remaining 35% provides supporting evidence. A score of 25 (one major signal) = DEVELOPING. A score of 45+ (two major signals) = READY.

### 4.4 State machine

```
WATCHING ──(any signal fires)──► DEVELOPING
DEVELOPING ──(score ≥ 45 AND past 10:00 AM ET)──► READY
DEVELOPING ──(declining on increasing volume, no exhaustion)──► CAUTION
CAUTION ──(volume exhaustion detected)──► DEVELOPING
READY ──(signals fade, score < 30)──► WATCHING
```

**First-30-minute suppression:** Between 9:30-10:00 AM ET, no ticker can enter READY state regardless of score. The opening range is noisy (overnight order flow, gap fills). Signals during this window are tagged LOW_CONFIDENCE in the UI but still displayed. After 10:00 AM, normal state transitions resume.

**CAUTION state (falling knife filter):** If a ticker is declining on *increasing* volume (each new 5-min bar has higher volume than the prior AND price is lower), it enters CAUTION. This is the explicit "the selling isn't done yet" signal. CAUTION blocks READY state until volume exhaustion is detected (a volume spike followed by declining volume on the next 2+ bars). This is the discipline gate the user asked for.

### 4.5 Finnhub WebSocket specifics

**Connection:** `wss://ws.finnhub.io?token=${FINNHUB_API_KEY}`

**Subscribe:**
```json
{"type": "subscribe", "symbol": "AAPL"}
```

**Unsubscribe:**
```json
{"type": "unsubscribe", "symbol": "AAPL"}
```

**Incoming message format:**
```json
{"data": [{"p": 178.25, "s": "AAPL", "t": 1688888888000, "v": 100}], "type": "trade"}
```
Fields: `p` = price, `s` = symbol, `t` = timestamp (ms), `v` = volume.

**Reconnection:** On disconnect, wait 1s, reconnect, resubscribe all symbols. Cap retries at 5 with exponential backoff (1s, 2s, 4s, 8s, 16s), then log error and surface "Live data unavailable" in UI.

**Free tier limit:** 50 concurrent symbol subscriptions. No rate limit on incoming messages. Hot list is capped to 46 tickers (+ SPY/QQQ/VIX/^TNX = 50 total).

### 4.6 SSE push model

**Why SSE over WebSocket or polling:**
- Unidirectional (server → client only) — the client never sends data to the live stream, just receives updates
- Works through standard HTTP — no additional WebSocket server infrastructure needed on Replit
- Native browser `EventSource` API — simpler than managing a client-side WebSocket
- React Query can consume SSE via `queryClient.setQueryData()` on each event
- Graceful degradation: if SSE disconnects, `GET /api/live/state` provides a full snapshot for reconnection

**Push cadence:** Server pushes a `LiveUpdate` event every time a ticker's state changes (WATCHING → DEVELOPING, score changes by > 5 points, new candle closes). Market context (SPY/VIX prices) pushed every 30 seconds. This avoids flooding the client — typical volume is 1-3 events per minute during normal trading, spikes to 10-15 during volatile sessions.

### 4.7 Market hours gating

| Period | Behavior |
|---|---|
| Pre-market (before 9:30 AM ET) | Show "Market opens in {countdown}." Display previous session's hot list with stale data. No WebSocket connection. |
| Market open (9:30-10:00 AM ET) | WebSocket active, candles building, indicators warming up. All signals tagged LOW_CONFIDENCE. No READY states allowed. |
| Core session (10:00 AM - 3:45 PM ET) | Full functionality. State machine operates normally. |
| Last 15 min (3:45-4:00 PM ET) | Suppress new READY signals (too late to enter for same-day; premium sellers should already be positioned). |
| After hours (after 4:00 PM ET) | Show "Market closed." Display final session snapshot as read-only. Disconnect WebSocket. |

### 4.8 Degradation behavior

| Failure | Behavior |
|---|---|
| Finnhub WebSocket disconnects | Reconnect with exponential backoff. Show "Live data reconnecting..." banner. Existing candle data preserved in memory. |
| Finnhub WebSocket fully down (5 retries exhausted) | Show "Live data unavailable" banner. Panel 3 switches to static mode showing last-known scanner rankings without intraday signals. |
| Partial data (only N of M tickers streaming) | Show data for available tickers, gray-out missing ones. Log which symbols failed to subscribe. |
| Scanner cache empty (server just started) | Show "Waiting for scanner data..." — hot list can't be derived until first scanner refresh completes. |
| Portfolio CSV not uploaded | Panel 2 shows "No portfolio data — upload a Robinhood CSV on the Portfolio tab." Panel 3 unaffected. |

### 4.9 Hot list refresh

- **Initial build:** On market open (or when Live tab first loaded during market hours), derive hot list from scanner cache.
- **Refresh cadence:** Every 15 minutes during market hours, re-derive from scanner cache. Diff against current hot list. Unsubscribe removed tickers from Finnhub WebSocket, subscribe new ones. Preserve candle/indicator state for tickers that remain.
- **Manual override:** User can pin/unpin tickers on the hot list (localStorage). Pinned tickers stay even if they fall out of scanner top-10. Unpinned tickers are excluded even if scanner ranks them.
- **Cap:** 46 tickers max (+ 4 market context symbols = 50 Finnhub limit).

### 4.10 News context caveat

Finnhub's `/company-news` endpoint returns corporate news (earnings, filings, analyst coverage). It does NOT reliably surface the macro catalyst for today's move (e.g., "tariffs reinstated" is SPY-level news, not AAPL-level). The 1-line headline in the opportunities table is **best-effort context** — it may show a relevant headline, or it may show a generic news item. The user still needs to assess "why did this stock move" using external judgment. The news column reduces the need to alt-tab for obvious cases (earnings, FDA approvals, bankruptcy) but does not replace macro context assessment.

---

## 5. Phases

### Phase 1: Backend — WebSocket + Candle Infrastructure (W1-W3)
- `lib/finnhub-ws.ts` — WebSocket manager
- `lib/candle-aggregator.ts` — tick → 5-min candle + VWAP
- `lib/live-hotlist.ts` — scanner-derived hot list manager
- **Verify:** WebSocket connects, subscribes to hot list, builds candles from tick stream. Log output to confirm data flow.
- Effort: M (2-3 days)

### Phase 2: Backend — Streaming TA Engine (W4-W6)
- `lib/live-signals.ts` — indicator instances, divergence detection, composite scoring, state machine
- Warmup logic (fetch 78 bars from Finnhub REST at session start)
- Time-of-day volume normalization
- First-30-minute suppression + CAUTION state logic
- **Verify:** Seed with historical data, confirm RSI/MACD/BB values match `technicalindicators` output for same input within epsilon ≤ 0.01. State machine transitions correctly on synthetic data.
- Effort: M (2-3 days)

### Phase 3: Backend — API Layer (W7-W8)
- `routes/live.ts` — SSE stream + snapshot + news proxy
- Position alert computation from `portfolioOptions`
- Market hours gating logic
- **Verify:** SSE stream delivers events to curl. Snapshot endpoint returns valid JSON. News endpoint caches correctly.
- Effort: S (1-2 days)

### Phase 4: Frontend — Live Tab Page (W9)
- `pages/live.tsx` — three-panel layout
- SSE subscription hook (`useLiveStream`)
- Market context bar (extend `MarketChip`)
- Position alerts table
- Opportunities table with state badges, composite score, sort controls
- Nav item in `TopNav`
- Route in `App.tsx`
- **Verify:** Page renders, SSE updates flow to UI, state badges color correctly, table sorts by score.
- Effort: L (3-4 days)

### Phase 5: Frontend — Detail View + Polish (W10-W11)
- Click-to-expand: mini chart with BB/VWAP overlays (reuse `LightweightPriceChart`)
- Signal breakdown component (which signals are firing, which aren't)
- Inline scanner strike display for selected ticker
- Sector exposure warning
- **Verify:** Chart renders with overlays, signal detail accurate, sector warning appears when applicable.
- Effort: M (2 days)

**Total: ~12-15 days across 5 phases.**

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Finnhub free tier WebSocket unreliable | Reconnection logic with exponential backoff; degrade gracefully to static scanner view |
| `trading-signals` library abandoned or buggy | Cross-validate against `technicalindicators` output during Phase 2 warmup. Library has 964 GitHub stars, last release Jan 2026, zero deps — low risk |
| Composite scoring weights are wrong | Weights are initial estimates. Phase 6 (ongoing tuning) adjusts based on live usage. User can visually see which signals fired and override the ranking |
| 5-min candle resolution too slow for fast moves | 5-min is a deliberate choice — sub-minute resolution produces too much noise for put-selling (premium doesn't change that fast). If needed, can add 1-min mode later |
| Portfolio CSV staleness makes Panel 2 unreliable | Explicitly shown with staleness warning + export date. Panel 2 is a convenience, not a source of truth — user always verifies on Robinhood before acting |
| News headline doesn't explain the move | Documented as best-effort in §4.10. Macro-level catalysts (tariffs, Fed) require external assessment; Finnhub company news covers stock-specific events |

---

## Appendix A: Implementation Reference Pack

> Pre-researched integration points, API schemas, and copy-paste-ready patterns so the implementing agent can code without exploring or researching.

### A1. File Touchpoint Map

**New files to create:**

| File | Purpose | Phase |
|---|---|---|
| `artifacts/api-server/src/lib/finnhub-ws.ts` | WebSocket connection manager — connect, subscribe, unsubscribe, auto-reconnect, heartbeat | P1 |
| `artifacts/api-server/src/lib/candle-aggregator.ts` | Tick → 5-min OHLCV candle builder with session-anchored VWAP accumulator | P1 |
| `artifacts/api-server/src/lib/live-hotlist.ts` | Scanner-derived hot list manager — refresh every 15 min, diff/subscribe/unsubscribe | P1 |
| `artifacts/api-server/src/lib/live-signals.ts` | Per-ticker streaming indicator instances, divergence detection, composite scoring, state machine | P2 |
| `artifacts/api-server/src/routes/live.ts` | Express router: `GET /live/state` (snapshot), `GET /live/stream` (SSE), `GET /live/news/:ticker` (Finnhub company news proxy) | P3 |
| `artifacts/stock-compare/src/pages/live.tsx` | Three-panel Live page (market context bar, position alerts, opportunities table) | P4 |
| `artifacts/stock-compare/src/hooks/use-live-stream.ts` | SSE consumption hook — `EventSource` → `queryClient.setQueryData` | P4 |

**Existing files to modify:**

| File | Line(s) | Change | Phase |
|---|---|---|---|
| `artifacts/api-server/src/routes/index.ts` | L24 | Add `import liveRouter from "./live";` after `dataHealthRouter` import | P3 |
| `artifacts/api-server/src/routes/index.ts` | L58 | Add `"/live"` to the `requireAuth` path array: `router.use(["/stocks", "/indicators", "/options", "/technical", "/explain", "/sdm", "/live"], requireAuth);` | P3 |
| `artifacts/api-server/src/routes/index.ts` | L64 | Add `router.use(liveRouter);` after `sdmRouter` mount | P3 |
| `artifacts/stock-compare/src/components/top-nav.tsx` | L3 | Add `Activity` to lucide-react import | P4 |
| `artifacts/stock-compare/src/components/top-nav.tsx` | L29 (after Macro entry) | Add `{ id: "live", href: "/live", label: "Live", icon: Activity },` to `LEFT_NAV_ITEMS` | P4 |
| `artifacts/stock-compare/src/App.tsx` | lazy imports (~L15) | Add `const Live = lazy(() => import("./pages/live"));` | P4 |
| `artifacts/stock-compare/src/App.tsx` | routes (~L107) | Add `<Route path="/live"><ProtectedRoute><Live /></ProtectedRoute></Route>` | P4 |

### A2. Finnhub API Exact Schemas

**A2.1 WebSocket Trades (real-time price stream)**

```
URL: wss://ws.finnhub.io?token=${process.env.FINNHUB_API_KEY}
Free tier: 50 concurrent symbol subscriptions. No rate limit on incoming messages.
```

Subscribe message:
```json
{"type": "subscribe", "symbol": "AAPL"}
```

Unsubscribe message:
```json
{"type": "unsubscribe", "symbol": "AAPL"}
```

Incoming trade message:
```json
{
  "type": "trade",
  "data": [
    {"s": "AAPL", "p": 178.25, "t": 1688888888000, "v": 100, "c": ["1", "12"]}
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `s` | string | Symbol |
| `p` | number | Last trade price |
| `t` | number | UNIX timestamp in **milliseconds** |
| `v` | number | Trade volume (0 for price-only updates on exchanges that don't stream individual trades) |
| `c` | string[] | Trade condition codes (optional) |

Server also sends `{"type": "ping"}` — the `ws` library handles pong automatically if you don't disable it.

TypeScript interface:
```typescript
interface FinnhubTrade {
  s: string;
  p: number;
  t: number;
  v: number;
  c?: string[];
}

interface FinnhubTradeMessage {
  type: "trade";
  data: FinnhubTrade[];
}
```

**A2.2 Stock Candles REST (5-min history for warmup)**

```
GET https://finnhub.io/api/v1/stock/candle?symbol={SYMBOL}&resolution=5&from={UNIX_SEC}&to={UNIX_SEC}&token={KEY}
Rate limit: 60 calls/min free tier. Intraday data limited to 1 month per request.
```

Response (success):
```json
{
  "s": "ok",
  "c": [178.25, 178.50],
  "h": [178.80, 178.90],
  "l": [177.90, 178.10],
  "o": [178.00, 178.30],
  "t": [1688888400, 1688888700],
  "v": [15000, 12000]
}
```

Response (no data):
```json
{"s": "no_data"}
```

| Field | Type | Description |
|---|---|---|
| `s` | string | `"ok"` or `"no_data"` |
| `c` | number[] | Close prices |
| `h` | number[] | High prices |
| `l` | number[] | Low prices |
| `o` | number[] | Open prices |
| `t` | number[] | Timestamps (UNIX **seconds**, not ms) |
| `v` | number[] | Volumes |

Arrays are parallel — `c[i]`, `h[i]`, `l[i]`, `o[i]`, `t[i]`, `v[i]` describe the same bar.

TypeScript interface:
```typescript
interface FinnhubCandleResponse {
  s: "ok" | "no_data";
  c?: number[];
  h?: number[];
  l?: number[];
  o?: number[];
  t?: number[];
  v?: number[];
}
```

To fetch 78 bars of 5-min data (6.5h = full trading day): set `from` to 9:30 AM ET today as UNIX seconds, `to` to current time.

**A2.3 Company News REST**

```
GET https://finnhub.io/api/v1/company-news?symbol={SYMBOL}&from={YYYY-MM-DD}&to={YYYY-MM-DD}&token={KEY}
Rate limit: 60 calls/min (shared with all REST endpoints).
```

Response: top-level JSON array.
```json
[
  {
    "category": "company",
    "datetime": 1688888888,
    "headline": "AAPL beats Q3 estimates",
    "id": 25286,
    "image": "https://example.com/thumb.jpg",
    "related": "AAPL",
    "source": "Reuters",
    "summary": "Apple reported quarterly earnings...",
    "url": "https://example.com/article"
  }
]
```

TypeScript interface:
```typescript
interface FinnhubNewsItem {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
}
```

Cache with `TTLCache<FinnhubNewsItem[]>` at 15-min TTL. Only need the first item's `headline` + `source` for the opportunities table 1-liner.

**A2.4 Quote REST**

```
GET https://finnhub.io/api/v1/quote?symbol={SYMBOL}&token={KEY}
```

Response:
```json
{"c": 178.25, "d": 1.50, "dp": 0.85, "h": 179.00, "l": 176.50, "o": 177.00, "pc": 176.75, "t": 1688888888}
```

| Field | Description |
|---|---|
| `c` | Current price |
| `d` | Dollar change |
| `dp` | Percent change |
| `h` | Day high |
| `l` | Day low |
| `o` | Day open |
| `pc` | Previous close |
| `t` | Timestamp (UNIX seconds) |

### A3. `trading-signals` Library v7 Exact Usage

> v7 removed big.js and the `Faster` prefix variants. All classes now use plain JS `number` natively. The method to feed data is `.add()` (not `.update()`). `getResult()` returns `null` when unstable (safe). `getResultOrThrow()` throws `NotEnoughDataError`.

```
npm install trading-signals
```

**Imports:**
```typescript
import {
  RSI, MACD, BollingerBands, StochasticOscillator,
  EMA, ATR, NotEnoughDataError
} from 'trading-signals';
```

**RSI:**
```typescript
const rsi = new RSI(14);
rsi.add(closePrice);                     // feed one price per candle close
if (rsi.isStable) {
  const value: number = rsi.getResult();  // 0-100, null if not stable
}
// getResult() returns null if not stable — safe to call anytime
// getResultOrThrow() throws NotEnoughDataError if not stable
// isStable = true after 14 inputs
// getSignal() returns { state: 'BULLISH'|'BEARISH'|'SIDEWAYS'|'UNKNOWN', hasChanged: boolean }
```

**MACD (constructor takes EMA instances, not period numbers):**
```typescript
const macd = new MACD(new EMA(12), new EMA(26), new EMA(9));
macd.add(closePrice);
if (macd.isStable) {
  const result = macd.getResult();
  // result = { macd: number, signal: number, histogram: number }
  // Detect histogram turn:
  //   prev.histogram < 0 && curr.histogram > 0 → bullish crossover
  //   prev.histogram > 0 && curr.histogram < 0 → bearish crossover
  // For DEVELOPING detection: histogram negative but increasing → momentum shifting
}
// Stable after ~26 inputs (long EMA period)
```

**Bollinger Bands:**
```typescript
const bb = new BollingerBands(20, 2);
bb.add(closePrice);
if (bb.isStable) {
  const result = bb.getResult();
  // result = { upper: number, middle: number, lower: number }
  // Bandwidth: (upper - lower) / middle
  // %B position: (price - lower) / (upper - lower)
  // Lower band touch: price <= lower
}
// Stable after 20 inputs
```

**Stochastic Oscillator (takes candle object, not scalar):**
```typescript
const stoch = new StochasticOscillator(14, 3, 3);
// Constructor: (n=%K period, m=%K smoothing, p=%D period)
stoch.add({ high: candle.high, low: candle.low, close: candle.close });
if (stoch.isStable) {
  const result = stoch.getResult();
  // result = { stochK: number, stochD: number }
  // %K cross above %D from below 20 = bullish signal
}
// Stable after n + p + 1 = 18 inputs
```

**ATR (takes candle object):**
```typescript
const atr = new ATR(14);
atr.add({ high: candle.high, low: candle.low, close: candle.close });
if (atr.isStable) {
  const value: number = atr.getResult();
}
```

**Error handling pattern for all indicators:**
```typescript
// Safe — returns null if not ready
const val = indicator.getResult();
if (val !== null) { /* use val */ }

// Or check stability first
if (indicator.isStable) {
  const val = indicator.getResult(); // guaranteed non-null
}
```

### A4. Route Registration — Exact Code

The route index is at `artifacts/api-server/src/routes/index.ts`. Routes are organized into public (no auth) and vendor-cost (auth-gated) sections. Live routes make Finnhub calls, so they go in the auth-gated block.

**Step 1 — Add import (after line 25, near other imports):**
```typescript
import liveRouter from "./live";
```

**Step 2 — Add "/live" to the requireAuth path array at line 58:**
Change:
```typescript
router.use(["/stocks", "/indicators", "/options", "/technical", "/explain", "/sdm"], requireAuth);
```
To:
```typescript
router.use(["/stocks", "/indicators", "/options", "/technical", "/explain", "/sdm", "/live"], requireAuth);
```

**Step 3 — Mount the router (after sdmRouter at line 64):**
```typescript
router.use(liveRouter);
```

**Important context from index.ts comments:** Do NOT mount after `watchlistRouter`/`feedRouter`/`positionsRouter` (lines 77-79) — those have internal blanket `requireAuth` and must stay last. Insert the live router in the vendor-cost auth block alongside stocks/indicators/options/sdm.

### A5. Nav + Route Registration — Exact Code

**top-nav.tsx — Add nav item:**

In the lucide-react import (line 3), add `Activity`:
```typescript
import {
  BarChart2, Bookmark, BriefcaseBusiness, Trophy, Globe, User, Settings as SettingsIcon,
  Activity,
} from "lucide-react";
```

In `LEFT_NAV_ITEMS` array (after the Macro entry at line 29), add:
```typescript
{ id: "live", href: "/live", label: "Live", icon: Activity },
```

**App.tsx — Add lazy import + route:**

Near the other lazy imports (around line 15):
```typescript
const Live = lazy(() => import("./pages/live"));
```

In the route block (after the `/macro` route around line 107):
```typescript
<Route path="/live">
  <ProtectedRoute><Live /></ProtectedRoute>
</Route>
```

### A6. Portfolio Position Query — Exact Drizzle Pattern

Panel 2 (Position Alerts) needs open short options from the latest Robinhood snapshot. The `portfolioOptions` table schema is at `lib/db/src/schema/index.ts` L737-768.

```typescript
import { db, portfolioSnapshots, portfolioOptions } from "@workspace/db";
import { eq, and, gte, or, desc, isNull } from "drizzle-orm";

async function getOpenShortOptions() {
  const today = new Date().toISOString().slice(0, 10);

  const [latest] = await db.select({ id: portfolioSnapshots.id })
    .from(portfolioSnapshots)
    .orderBy(desc(portfolioSnapshots.importedAt))
    .limit(1);

  if (!latest) return [];

  return db.select()
    .from(portfolioOptions)
    .where(and(
      eq(portfolioOptions.snapshotId, latest.id),
      eq(portfolioOptions.direction, 'short'),
      or(
        gte(portfolioOptions.expiration, today),
        isNull(portfolioOptions.expiration),
      ),
    ));
}
```

**Key fields for capture % calculation:**
- `avgPremium` (numeric string) — premium collected per contract when sold
- `markPrice` (numeric string) — current option mark price (cost to buy back)
- `bid` / `ask` (numeric strings) — use midpoint if `markPrice` is null
- `symbol` — underlying ticker
- `optionType` — `'call'` or `'put'`
- `strike` (numeric string)
- `expiration` (date string `YYYY-MM-DD`)
- `qty` (numeric string) — number of contracts

**Capture % formula:**
```typescript
const avgPrem = parseFloat(opt.avgPremium ?? '0');
const mid = parseFloat(opt.markPrice ?? '0')
  || (parseFloat(opt.bid ?? '0') + parseFloat(opt.ask ?? '0')) / 2;
const capturedPct = avgPrem > 0 ? ((avgPrem - mid) / avgPrem) * 100 : 0;
// capturedPct > 30 && capturedPct < 60 → highlight as "RV rotation candidate"
// capturedPct >= 60 → highlight as "strong close candidate"
```

**Staleness check:** Compare `portfolioSnapshots.importedAt` to now. If > 24h, show staleness warning in Panel 2 header.

### A7. Scanner Hot List Derivation — Exact Logic

The `getAllCachedIndicators()` function at `artifacts/api-server/src/lib/indicators.ts` L407 returns `IndicatorResult[]` for all tickers with today's cached data. The hot list selects the best candidates from these.

**Sort dimensions** (from `SortKey` type at `options-scanner.tsx` L63):
- `optionScore` — not directly on `IndicatorResult`; derived from option chain data
- `score` — composite technical score; use `tier` (1=best, 3=worst) as proxy, then `rsi` ascending
- `income` — not on `IndicatorResult`; derived from option chain. Skip for hot list v1
- `iv` — `ivCurrent` field on `IndicatorResult`
- `buffer` — not on `IndicatorResult`; derived from option chain. Skip for hot list v1

**Practical v1 hot list derivation (uses fields available on `IndicatorResult`):**

```typescript
import { getAllCachedIndicators, IndicatorResult } from "../lib/indicators.js";

async function deriveHotList(): Promise<string[]> {
  const all = await getAllCachedIndicators();
  if (all.length === 0) return [];

  const tickers = new Set<string>();

  // Top 10 by lowest RSI (most oversold — prime put-sell reversal candidates)
  const byRsi = [...all].sort((a, b) => a.rsi - b.rsi);
  byRsi.slice(0, 10).forEach(r => tickers.add(r.ticker));

  // Top 10 by highest IV (richest premiums)
  const byIv = [...all].sort((a, b) => b.ivCurrent - a.ivCurrent);
  byIv.slice(0, 10).forEach(r => tickers.add(r.ticker));

  // Top 10 by largest 5-day drop (biggest movers down — reversal candidates)
  const byDrop = [...all]
    .filter(r => r.return5d != null)
    .sort((a, b) => (a.return5d ?? 0) - (b.return5d ?? 0));
  byDrop.slice(0, 10).forEach(r => tickers.add(r.ticker));

  // Top 10 by lowest stochastic (oversold by cycle)
  const byStoch = [...all]
    .filter(r => r.stoch != null)
    .sort((a, b) => (a.stoch ?? 100) - (b.stoch ?? 100));
  byStoch.slice(0, 10).forEach(r => tickers.add(r.ticker));

  // Cap at 46 (4 market context symbols use the remaining 4 of 50)
  const list = [...tickers].slice(0, 46);
  return list;
}
```

**Market context symbols** (always subscribed, outside the 46 cap):
- `SPY`, `QQQ` — broad market
- VIX via Finnhub uses symbol `CBOE:VIX` (verify — may need `^VIX` or `VIX` depending on Finnhub convention)
- 10Y yield: Finnhub WebSocket does not stream treasury yields. Use existing macro data or a REST poll from `fetchMacroData()` in `lib/macro-data.ts`.

### A8. Express SSE — Copy-Paste Pattern

The codebase has no existing SSE endpoint. This is the pattern to use in `routes/live.ts`:

**Server side:**
```typescript
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { liveEngine } from "../lib/live-signals.js";

const router = Router();

router.get("/live/stream", requireAuth, (req: Request, res: Response) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.write("data: {\"type\":\"connected\"}\n\n");

  const keepAlive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 30_000);

  const onUpdate = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  liveEngine.on("update", onUpdate);

  req.on("close", () => {
    clearInterval(keepAlive);
    liveEngine.off("update", onUpdate);
  });
});

router.get("/live/state", requireAuth, async (_req: Request, res: Response) => {
  res.json(liveEngine.getSnapshot());
});

export default router;
```

**Client side (`hooks/use-live-stream.ts`):**
```typescript
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useLiveStream(enabled: boolean) {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const es = new EventSource("/api/live/stream", { withCredentials: true });
    esRef.current = es;

    es.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "connected") return;
      queryClient.setQueryData(["live-state"], (old: unknown) => {
        return { ...(old as object), ...data };
      });
    };

    es.onerror = () => {
      fetch("/api/live/state", { credentials: "include" })
        .then(r => r.json())
        .then(data => queryClient.setQueryData(["live-state"], data))
        .catch(() => {});
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [enabled, queryClient]);
}
```

**Important:** The `liveEngine` should extend `EventEmitter` (from Node.js `events` module) and emit `"update"` events whenever a ticker's state changes or market context updates. This decouples the SSE transport from the engine logic.

### A9. Existing Finnhub Client — Patterns to Follow

The codebase already has `artifacts/api-server/src/lib/finnhub-client.ts` for Finnhub REST calls. Follow its conventions:

**API key access:**
```typescript
const apiKey = process.env.FINNHUB_API_KEY;
if (!apiKey) throw new Error("FINNHUB_API_KEY not set");
```

**Retry logic** (reuse or import `fetchWithRetry` from `finnhub-client.ts`):
- Base delay: 1200ms (Finnhub free tier = 60 calls/min)
- Exponential backoff on failure
- 429 status → double the delay, log warning via `logger.warn()`
- 404 → return null (not an error)
- Max 3 retries

**API usage logging** (import from `lib/api-logger.ts`):
```typescript
import { logApiCall } from "./api-logger.js";

logApiCall({
  source: "finnhub",
  fn: "fetchCandlesForWarmup",
  trigger: "live-engine-startup",
  ticker: symbol,
  outcome: "success",
  fieldsReturned: bars,
});
```

**Logger** (import from `lib/logger.ts`):
```typescript
import { logger } from "./logger.js";
logger.info({ symbols: hotList.length }, "live: WebSocket subscribing");
logger.warn({ symbol, attempt }, "live: reconnecting");
logger.error({ err }, "live: WebSocket connection failed");
```

**WebSocket dependency:** The existing project uses Node.js built-in `fetch` for REST. For WebSocket, install `ws`:
```
npm install ws && npm install -D @types/ws
```
Or use Node.js 22+ built-in `WebSocket` if the runtime supports it — check `node --version` in the Replit environment first. If >= 22, no extra dependency needed.
