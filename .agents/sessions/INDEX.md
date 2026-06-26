# Session Index

Full detail for each date at `.agents/sessions/claude-YYYY-MM-DD.md` (Claude) or `cursor-YYYY-MM-DD.md` (Cursor).
Pre-2026-06-08 history: `.claude/docs/session-history.md`

- [2026-06-26](claude-2026-06-26.md) — Built AV+Polygon data pipeline, wired into SDM waterfall, backfill script scoped and paced correctly — nightly runs will fill CRITICAL fields over ~5 days. | build | next: 1) Add Yahoo Finance + SEC EDGAR to backfill waterfall in backfill-fundamentals.ts. 2) Run corrected backfill after midnight UTC (158 tickers, all fixes applied). 3) Stock DB UI enhancements: Fundamental group label, Technical score columns
- [2026-06-25](claude-2026-06-25.md) — auto-saved | build | next: 1) Enhance Stock DB tab: add Fundamental group label, Technical columns, per-ticker status icon (queued/in-progress/done)
- [2026-06-24](claude-2026-06-24.md) — auto-saved | build | next: Apply DB migration 0001 (run drizzle-kit migrate from Replit shell with env vars). Verify macro tab loads cleanly. Then file-split: options-scanner.tsx(1199L), stock-breakdown.tsx(1084L), portfolio.tsx(955L)
- [2026-06-22](claude-2026-06-22.md) — auto-saved | build | next: reset user password; verify profile page in browser; Phase 5 FILDI approval; verify chart EMA lines and zone labels
- [2026-06-21](claude-2026-06-21.md) — auto-saved | build | next: reset user password; verify profile page in browser; Phase 5 FILDI approval; verify chart EMA lines and zone labels
- [2026-06-19](claude-2026-06-19.md) — auto-saved | build | next: build POST /api/portfolio/import route; reset user password; verify profile page in browser; Phase 5 FILDI approval; verify chart EMA lines and zone labels
- [2026-06-18](cursor-2026-06-18.md) — Cursor | watchlist-stock-analysis: Competitors 50/50 tech+fund, catalysts, DB-first peers | next: options-comparison-table; smoke-test competitors on Replit
- [2026-06-18](claude-2026-06-18.md) — auto-saved | build | next: Reset user password;verify profile page in browser;Phase 5 FILDI approval;verify chart EMA lines and zone labels
- [2026-06-17](claude-2026-06-17.md) — auto-saved | build | next: Reset user password; get Phase 5 FILDI approval; commit all work; verify chart EMA lines and zone labels render correctly in browser
- [2026-06-16](claude-2026-06-16.md) — auto-saved | build | next: Scorecard Guide: update model logic description + readability. Consider committing all UI polish changes.
- [2026-06-15](claude-2026-06-15.md) — auto-saved | build | next: test/verify accuracy of options scanner enhancements — Q&A on scoring logic, StrikeCard fields, MacroBanner
- [2026-06-14](claude-2026-06-14.md) — auto-saved | build | next: options-comparison-table, strike-explorer-slider, user-management-system
- [2026-06-12](claude-2026-06-12.md) — auto-saved | build | next: options-comparison-table, strike-explorer-slider, user-management-system
- [2026-06-11](claude-2026-06-11.md) — auto-saved | build | next: options-comparison-table, strike-explorer-slider, user-management-system
- [2026-06-10](claude-2026-06-10.md) — auto-saved | build | next: options-comparison-table, strike-explorer-slider, user-management-system
- [2026-06-10](claude-2026-06-10.md) — context consolidation + Kiro setup | build | next: user-management-system, options-comparison-table, strike-explorer-slider
- [2026-06-10](claude-2026-06-10.md) — AI score explanations + options scanner persistence | build | next: options-comparison-table, strike-explorer-slider, user-management-system
- [2026-06-09](claude-2026-06-09.md) — technical scorer V2 (all 5 phases) | build | next: options-comparison-table, strike-explorer-slider
- [2026-06-09](claude-2026-06-09.md) — FMP data layer + WACC/safety metrics | build | next: technical-scorer-v2, options-comparison-table
- [2026-06-08](claude-2026-06-08.md) — fundamental scorer V2 (4 families, 13 metrics) | build | next: fmp-phase1, technical-scorer-v2
