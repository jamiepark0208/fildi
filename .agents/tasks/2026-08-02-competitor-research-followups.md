FEATURE: Competitor-research follow-up ideas (not yet scoped/built)
STATUS: planning
AGENT: claude
STARTED: 2026-08-02
SUBTASKS:
  - [ ] Sentiment/social signal layer (StockTwits-style) — no existing data source or schema; net-new integration
  - [ ] Snowflake-style visual summary (SimplyWallSt) — presentation-layer only, blend existing value/growth/quality/safety scores into one radar chart
  - [ ] Per-strategy accuracy ranking (TipRanks analyst-ranking analog) — only makes sense once >1 scoring strategy exists to compare
  - [ ] Per-ticker "why did this move today" AI digest (Robinhood Cortex Digests analog) — daily-brief.ts is market-wide only today, not per-ticker/news-tied
  - [ ] Statistical significance gating on accuracy chips — current chips (signal-accuracy-chip.tsx, credibility-badge.tsx) use flat n>=5 cutoff; TipRanks-style would add a real min-n + Z-test before showing a win rate
NOTES:
  Surfaced during research for the Live-tab AI-insight backlog (see 571f157). Explicitly out of
  scope for that work since it targeted surfacing existing data, not net-new capability. None
  approved or scoped yet — pick one and scope it as its own plan before building.
