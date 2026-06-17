# FILDI Phase 4 — Global Feed Page Report
**Date:** 2026-06-17  
**Feature:** Social / Trade Ideas (FILDI)  
**Phase:** 4 of N — Global Feed Page

## What was done

### feed.tsx (new page at /feed)
- Top bar: "Post Trade Idea" button (right-aligned), toggles inline SubmitForm (duplicated from profile.tsx for now)
- Search input (debounced 400ms): `@username` prefix → username filter; otherwise → ticker filter (uppercased); × clear button
- Status filter pills: All | Open | Wins | Losses | Closed → maps to status query param
- Sort toggle: Recent | Top
- Feed list: TradeCard with showUser=true, isOwner wired, all action callbacks
- 3 skeleton cards during loading
- Load more button (offset-based, hidden when last page < 50 results)
- Empty state: "No trade ideas found."
- Right panel (desktop only, lg: breakpoint): Top Performers — derived client-side from top-100 posts query; groups by username, filters to ≥2 resolved posts, sorts by winRate desc → totalPnl desc, shows top 3 with clickable profile links

### App.tsx
- Added `/feed` route inside ProtectedRoute

### sidebar.tsx
- Added `LayoutList` icon from lucide-react
- Added "Feed" nav item at top of main group (above Watchlist)

## Verification
- `tsc --noEmit`: 0 errors
- Browser tests: skipped (no browser available in environment)

## Next
Phase 5 (awaiting approval).
