# feature-purpose-research
**Status:** done (research artifact)
**Priority:** —
**Area:** research
**Created:** 2026-07-09
**Source:** competitive-research + codebase baseline

### Resolution
Master reference mapping competitor gaps onto TradeDash's existing surfaces (Feed, Watchlist, Stock Breakdown, Profile, Portfolio, Home, Technical, Scanner, Macro tabs, Scorecard Guide, Settings) — default posture was "ENHANCE existing baseline" over greenfield builds. Established the cache/DB rules all downstream feature PRDs had to follow (no new TTLCache without registry entry, no Redis/job-queue, reuse existing routes, single SSOT for weights/catalysts). Spawned the numbered enhancement and new_app_features task files listed throughout the doc, each of which was individually scoped, reviewed, and (mostly) shipped or marked ready in INDEX.md.
