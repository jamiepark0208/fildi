# portfolio-analysis-improvements

| Field | Value |
|---|---|
| **Status** | done* — UI overhaul done; A1 nav-unlock and Phase B (wheel-cycle/journal) still open/backlog |
| **Priority** | P0 |
| **Area** | ui (+ thin schema only after design) |
| **Effort** | L (ship 5a first = S; wheel/journal = L) |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Related** | [portfolio-daily-brief](9-portfolio-daily-brief-improvements-070926.md), [ai/13](../ai/13-product-ai-trade-journal-loop-070926.md), [feed](13-feed-improvements-070926.md), [profile](14-profile-track-record-improvements-070926.md) |

### Resolution (2026-07-11)
Most original Phase A scope was superseded by a real bug found this session: "Portfolio Value" vs "Capital Allocation" mismatch, root-caused to the CSV parser silently discarding the `Cash` column and crypto value. Fixed by rewriting `portfolio-parser.ts` for full section parity (captures per-account cash/margin/buying-power/crypto, equity fundamentals, option OI/volume/bid/ask, and Robinhood's own `Strategy`/`Leg Effect` tags — the key primitive for wheel-cycle chaining). Schema additions applied via hand-written additive SQL (2 new tables, nullable columns only). `GET /api/portfolio/snapshot/latest` now returns account summaries and cash/crypto rollups; verified end-to-end against a real export.

**A1 (nav-unlock) deliberately deferred, not implemented**: owner decided the Robinhood-CSV admin view and a regular-user manual-entry view should stay separate rather than unlocking one page for everyone — that admin/regular-user branch split was built as part of bug/14's fix, so the machinery exists; only the sidebar `adminOnly` flag flip remains, intentionally held back pending more real-world use. **Phase B** (wheel-cycle grouping, journal tags) is now believed cheaper than originally scoped, since Robinhood already tags each option order's strategy and leg-open/close — but is still unbuilt. Frontend wiring of the new cash/crypto data into the Capital Allocation donut, and reordering the page layout, are also still pending. Ten additional portfolio-analysis enhancements were researched and documented as backlog only (not implemented).
