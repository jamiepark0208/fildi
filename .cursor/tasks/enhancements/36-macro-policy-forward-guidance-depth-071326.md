# macro-policy-forward-guidance-depth

| Field | Value |
|---|---|
| **Status** | backlog |
| **Priority** | P2 |
| **Area** | ui / data |
| **Effort** | M |
| **Created** | 2026-07-13 |
| **Source** | user comparison against a trader's-eye summary of what "Monetary Policy & Forward Guidance" should cover |
| **Related** | [macro-policy-tab-improvements](18-macro-policy-tab-improvements-070926.md) |
| **Type** | ENHANCE |

### Purpose
User asked whether the Policy tab actually covers what traders watch under "forward guidance" and pointed to a list that goes well beyond rate-path/SEP. Current tab (post enh/18) covers: Fed Dots vs. Market pricing, SEP projections, Fed member hawkish↔dovish stances, bank research rate views, and (as of this session) a Balance Sheet/QT card. It does **not** cover the following, each of which needs new data sourcing rather than just UI rework:

- **FOMC dissent counts / vote splits** — how many members dissented and on which side; signals internal friction vs. autopilot consensus. Needs FOMC statement/minutes parsing (no existing feed).
- **Statement lexical shifts** — tracking adjective changes across consecutive FOMC statements (e.g. "elevated" → "transitory", easing/tightening bias language). Needs statement text diffing, likely LLM-assisted.
- **Press conference Q&A nuance** — Fed Chair's impromptu emphasis on specific risks during Q&A. Needs transcript sourcing + summarization; heaviest lift on this list.
- **Treasury Quarterly Refunding Announcements** — auction sizes, bill/coupon issuance mix, cash management guidance; drives short-term liquidity and yield curve. Needs Treasury refunding calendar/statement feed (different domain than FRED series already used).
- **IMF World Economic Outlook** — global growth guidance for international trade/earnings context. Needs IMF publication feed.
- **Other central banks (ECB, BOJ, BOE)** — forward guidance affecting USD multinational earnings and FX. Needs each bank's own statement/rate-decision feed.
- **CME FedWatch-style probabilities** — explicit cut/hike probability by meeting date, not just the implied Fed Funds curve level we already chart. May be derivable from existing `fedFundsCurve` (convert implied rate vs. current target range into per-meeting probability), worth checking before sourcing a new feed.
- **Historical analogy / pattern-matching layer** (user request 2026-07-13, tied to Balance Sheet card) — don't just show the current QRA/balance-sheet data point, correlate it against past instances of the same event type and how markets reacted: e.g. "last time Treasury shifted issuance toward bills over coupons, [asset] did X over the following N weeks"; "last time a new Fed Chair was confirmed, [asset] did Y." Needs (1) a tagged event history — QRA announcements, Fed chair transitions, QE/QT regime starts, taper announcements — with dates, and (2) market-reaction snapshots (S&P, 10Y, DXY, etc.) over fixed windows after each tagged event. This is a distinct sub-feature from the raw QRA data feed above — surfacing the feed is necessary but not sufficient; the analogy/correlation synthesis is the harder, higher-value half. Pairs with [[enh/35]]'s narrative-quality pass once the underlying event history exists.

### Scope (to define at pickup)
- Triage by cost/complexity: FedWatch-style probabilities may be a pure derivation from data we already have (`fedFundsCurve`) — check this first, it's likely the cheapest win.
- Dissent counts are a bounded, structured fact (not prose) — likely feasible from FOMC statement text without a full LLM summarization pipeline.
- Lexical-shift tracking and press-conference nuance are open-ended NLP tasks — scope carefully, probably LLM-assisted with cached output (see [[enh/35]] ai-explanation-quality-improvements for the caching pattern to follow).
- Treasury refunding / IMF WEO / other central banks are each a new external feed — confirm free/reliable source exists before committing to build.
- Don't build all seven at once — pick the highest trader-value, lowest-cost item first (likely FedWatch probabilities or dissent counts) and re-scope the rest after.

### Cache / DB compliance
Any new external feed follows existing `ttl-cache.ts` pattern with an appropriately long TTL (these update at most a few times a month around FOMC meetings). No live Fed/Treasury wire polling.
