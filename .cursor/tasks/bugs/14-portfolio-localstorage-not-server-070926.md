# portfolio-localstorage-not-server

| Field | Value |
|---|---|
| **Status** | done (conditional) — 2026-07-11 |
| **Priority** | P1 |
| **Area** | multi-user / data |
| **Effort** | L |
| **Benefit** | High — portfolio follows user across devices |
| **Implementation risk** | High |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |

## Resolution

**Note:** INDEX.md lists this as "done (conditional)" — two P0 follow-ups still open, see FOLLOWUPS.md.

Shipped option A: `use-portfolio.ts` was rewritten to be server-backed (react-query against `/api/positions` and `/api/portfolio-names`) instead of unscoped localStorage, with a one-time client-side migration shim that POSTs any pre-existing localStorage entries to the server on first load then clears the legacy keys.

Two things discovered mid-implementation and fixed alongside: the `positions.ts` router existed but was never mounted in `routes/index.ts` (so `/api/positions` was 404ing), and manual "Add Position" was fully dead in the UI (no button wired, component never mounted) — folded into enh/8's admin/regular-user rescope.

**Known gap, not fixed in this pass:** `portfolioSnapshots` (Robinhood CSV ingest table) has no `userId` FK, so any authenticated user's ingest is visible to all users. Left open since the Portfolio tab is currently admin-only with one admin, but must be fixed before a second admin or wider access — tracked in FOLLOWUPS.md.
