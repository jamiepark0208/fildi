# competitive-ux-research
**Status:** done (research artifact)  
**Priority:** P0  
**Area:** research  
**Created:** 2026-07-09  
**Source:** competitive-research  

## Executive summary

TradeDash has **strong backend depth** (multi-source fundamentals, technical scoring, options chain analysis, macro regime, social feed skeleton) but **weak product packaging**. Competitors win on: (1) a clear "start here" home surface, (2) inline explanations at the moment of decision, (3) curated "today's picks" from trusted voices, (4) track records that build trust, and (5) progressive disclosure — simple default view, power features on expand.

Your usability problem is not missing data — it's **missing narrative, hierarchy, and trust signals**.

---

## 10 comparable apps

| App | Primary overlap with TradeDash | Why it matters |
|---|---|---|
| **StockTwits** | Social feed, sentiment, community | User-cited; FILDI feed/sentiment |
| **Covers.com** | Curated expert picks, community forums, contests | User-cited; "best picks" analog to CSP candidates |
| **Barchart** | Naked put / covered call screeners, unusual activity | Direct options-income scanner competitor |
| **OptionStrat** | Strike visualization, optimizer, flow alerts | Best-in-class options UX clarity |
| **TipRanks** | Analyst leaderboard, performance-weighted ratings | Trust via track record |
| **Koyfin** | Research dashboards, screeners, alerts | Clean information hierarchy |
| **TradingView** | Charts, screeners, community ideas | Navigation + discoverability patterns |
| **Seeking Alpha** | Contributor theses, quant ratings, trending analysis | Editorial + conviction framing |
| **Finviz** | Visual heat-map screener | At-a-glance market scan |
| **Robinhood** | Simple consumer investing UX | You already mirror their fundamental taxonomy |

---

## Best-loved features by app (UX-focused)

### StockTwits
- **Real-time sentiment** per ticker (bullish/bearish gauge) — cuts through noise
- **Trending lists** (most active, most watched, crypto) — instant "what's moving"
- **Community polls** on tickers — low-friction engagement
- **AI summaries** of community chatter — digest without reading 500 posts
- **Earnings call integration** with live sentiment shift

*User value:* "Tell me what others think **right now** without reading everything."

### Covers.com
- **Featured pick of the day** above the fold (e.g. "Featured Trade")
- **Expert picks organized by sport/event** with cheat sheets, parlays, props
- **Massive community** (810K+ members) with forums per league
- **Free-to-play contests** with prizes — gamified credibility
- **"Bet Smarter" newsletter** — daily curated entry point
- **Betting guides** (how to bet, calculators) — education as product surface

*User value:* "Who should I trust today, and **why** is this the pick?"

### Barchart
- **Options Market Overview** — one page: unusual activity, most active, top covered calls, vol index
- **Pre-built income strategy screeners** (Naked Put, Covered Call) — no config required to start
- **IV Rank / IV Percentile** front and center for premium sellers
- **Options Learning Center** linked from every options page
- **Unusual options activity** as default hook, not buried in settings

*User value:* "Show me income opportunities **now** with context (vol, flow, earnings)."

### OptionStrat
- **Strategy builder with P/L visualization** — see outcome before trading
- **Optimizer:** enter target price/date → ranked trade ideas
- **"Money tips"** inline on each feature — micro-education
- **Flow page** with filters, alerts, performance tracking on saved alerts
- **Plain-language value prop** on homepage: predict, optimize, follow smart money

*User value:* "Don't make me calculate — **show me** the trade and the odds."

### TipRanks
- **Analyst performance weighting** — not all opinions equal
- **"Rating reasoning"** column in screener — one-click why
- **Smart Score / Quant ratings** as secondary trust layer
- **Sector consensus charts** — macro context without leaving screener
- **Search any stock or expert** from home — universal entry

*User value:* "Prove your picks have a **track record**."

### Koyfin
- **"As powerful as it is simple"** — explicit design promise
- **Market dashboards** — curated big-picture before drill-down
- **Company snapshots** — one screen for everything on a ticker
- **Custom watchlist views** (save column sets) — personalization without complexity
- **Alerts with notes** ("what to do next") — action-oriented notifications

*User value:* "One screen answers my question; I drill down only if I want."

### TradingView
- **Command search (⌘K)** — any action in seconds
- **Feature tabs on one chart hub** — progressive depth
- **Community ideas** attached to symbols
- **100M user social proof** — reduces fear of "am I using this wrong?"

*User value:* "I always know **how to get somewhere**."

### Seeking Alpha
- **Trending analysis** with clear headlines and thesis hooks
- **"In case you missed it"** — resurface best content
- **Quant rating badges** on trending stocks table
- **Contributor ecosystem** with followable authors
- **Stock comparison** framing ("Stock A vs Stock B")

*User value:* "Give me a **story** and a conviction level, not just numbers."

### Finviz
- **Heat-map screener** — entire market visible in one glance
- **Color-coded signals** — instant pattern recognition
- **Saved screens** — return to your workflow in one click
- **Minimal chrome** — data density without nested menus

*User value:* "Let me **scan** before I analyze."

### Robinhood
- **Single primary action per screen**
- **Plain-language labels** (no jargon in nav)
- **Discovery feeds** (lists, themes) for users who don't know what to search
- **Fractional / simple order entry** — reduces paralysis

*User value:* "I shouldn't need a manual."

---

## What users consistently want (cross-app patterns)

Synthesized from competitor positioning, review themes, and options-income community norms:

1. **A obvious starting point** — "Today's best ideas" or "Scanner results" above the fold, not 12 sidebar links with equal weight
2. **Trust before complexity** — track record, win rate, sample size, "why this pick" in 2 sentences
3. **Explain scores in context** — tooltip/popover at the number, not a separate 20-page guide
4. **Progressive disclosure** — default = simple card (ticker, score, signal, best strike); expand for greeks, component breakdown, provenance
5. **Curated + social** — blend algorithm picks with human analyst/community picks (Covers + StockTwits model)
6. **Alerts that mean something** — "NVDA hit your criteria" not "data refreshed"
7. **Education woven in** — micro-copy ("IV rank 82 = rich premium") not a separate homework assignment
8. **Mobile-readable density** — competitors increasingly mobile-first; TradeDash tables are desktop-dense
9. **Compare peers in one click** — "how does this rank vs semis?" without navigating watchlist → competitors tab
10. **Macro context as banner, not a separate homework tab** — regime affects conviction; surface it on scanner/home

---

## TradeDash current-state gaps (UX)

From codebase review (not scoring algorithms):

| Area | Exists today | Gap vs competitors |
|---|---|---|
| Home `/` | Fundamental rankings table | No "today's narrative"; no featured pick; dense tables without hierarchy |
| Options scanner | Rich strike-level UI | Overwhelming columns; GO/WATCH/NO without onboarding; best strike buried in expand |
| Scorecard guide | Separate `/scorecard-explanation` page | Not contextual; user must know it exists (sidebar only) |
| Feed / Profile | Trade posts, stats, buckets | No trending, no leaderboards, no track-record weighting vs TipRanks/Covers |
| Macro | Full tab | Disconnected from scanner conviction; users don't see regime on pick cards |
| Navigation | Flat sidebar ~12 items | No "start here" vs "advanced"; no command search |
| AI explain | `POST /api/explain/score` on some views | Hidden; not default; session-cached but undiscoverable |
| Watchlist analysis | Deep per-stock view | Strong content, weak wayfinding — users land without knowing workflow |

**Core diagnosis:** TradeDash is built like a **Bloomberg terminal for one user** who already knows the workflow. Competitors are built like **products for arriving users**.

---

## Recommended features for TradeDash (prioritized)

### Tier 1 — Fix confusion (do first)

| Feature | Inspired by | TradeDash implementation sketch |
|---|---|---|
| **First-run product tour** | TradingView, Robinhood | 4-step overlay: Home → Scanner → Watchlist stock → Score meaning |
| **Contextual score tooltips** | Koyfin snapshots, Barchart learning center | Every score badge → popover with 1-line meaning + link to guide section |
| **Home as "Today" dashboard** | Covers featured pick + Barchart overview + Finviz scan | Top: macro banner + 3 featured CSP ideas + "why today" blurb; below: rankings |
| **Scanner "Simple mode"** | OptionStrat optimizer results | Default card: ticker, signal, best strike, %/wk, POP, one-line reasoning; "Advanced" toggles greeks table |

### Tier 2 — Build trust & habit

| Feature | Inspired by | Sketch |
|---|---|---|
| **Today's Top Picks** | Covers featured trade, Barchart top lists | Daily curated list (algo + optional admin pick) with thesis sentence |
| **Analyst / user leaderboard** | TipRanks, Covers community | Profile stats (win rate, P&L) promoted to `/feed` leaderboard; weight feed by track record |
| **Pick cards with "Why now"** | Seeking Alpha headlines | Each scanner row: headline-style reasoning string (you have `buildReasoning` — surface it prominently) |
| **Regime-aware badges on every pick** | Koyfin dashboards | Macro regime chip on scanner/home cards (partially exists in scanner — extend everywhere) |

### Tier 3 — Grow engagement

| Feature | Inspired by | Sketch |
|---|---|---|
| **Social sentiment polish** | StockTwits | Ticker sentiment strip on watchlist; trending tickers widget on feed |
| **Community polls / conviction** | StockTwits votes | "Bullish on this CSP?" on trade posts |
| **Command palette (⌘K)** | TradingView | Jump to ticker, page, or "explain score" |
| **Saved scanner presets** | Barchart screeners, Finviz saved screens | "My 1% weekly income watch" one-click filter |
| **Newsletter / daily brief hook** | Covers, Seeking Alpha | You have `/daily-brief` API — productize as email or home widget |

---

## Competitive positioning opportunity

TradeDash can own: **"Covers.com for put sellers"** — curated income ideas with transparent scoring, community track records, and macro-aware conviction — backed by deeper fundamentals than Barchart and more actionable than StockTwits chatter.

Differentiator to emphasize in UX copy: *"Every pick shows fundamental rank, technical signal, and best strike — with the math explained."*

---

## Sources consulted

- [StockTwits](https://www.stocktwits.com/) — homepage, sentiment, trending, AI features
- [Covers.com](https://www.covers.com/) — featured picks, community stats, guides, contests
- [Barchart Options](https://www.barchart.com/options) — market overview, income screeners, unusual activity
- [OptionStrat](https://optionstrat.com/) — optimizer, flow, education micro-copy
- [TipRanks Analyst Top Stocks](https://www.tipranks.com/screener/analysts-top-stocks) — analyst weighting, rating reasoning
- [Koyfin Features](https://koyfin.com/features/) — dashboards, simplicity positioning
- [TradingView Features](https://www.tradingview.com/features/) — command search, chart hub
- [Seeking Alpha](https://seekingalpha.com/) — trending analysis, quant ratings, contributor model
- TradeDash codebase: `sidebar.tsx`, `options-scanner.tsx`, `profile.tsx`, `watchlist.tsx`, `scorecard-explanation`

---

## Downstream tasks

See [INDEX.md](INDEX.md) for actionable task files spawned from this research.
