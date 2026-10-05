# daily-brief-factset-commentary

| Field | Value |
|---|---|
| **Status** | in-progress |
| **Priority** | P2 |
| **Area** | data + ai |
| **Effort** | M |
| **Created** | 2026-10-01 |
| **Type** | ENHANCE |
| **Related** | [portfolio-daily-brief](9-portfolio-daily-brief-improvements-070926.md), `.agents/context/desk-commentaries.md` |

### Purpose
Upgrade Daily Brief with FactSet StreetAccount desk emails (email ingest — not FactSet fundamentals API).

### Decision (2026-10-01)
- **Email ingest**, not StreetAccount API (no entitlement burn on fundamentals proxy).
- Gmail label → Apps Script **15‑min cloud poll** → Drive `TradeDash Briefs` → Postgres `desk_commentaries` → Daily Brief desk pack.
- Mac closed: script keeps running; **no missed-poll replay** needed. Ingest catch-up on wake only.
- Soft context for live/regime/scorecard narrative later — **never** hard-wired into fund_score.

### Done so far
- [x] Efficient Apps Script (`scripts/apps-script/SaveFactsetBriefs.gs`) — new-only + backfill + `.json` sidecar
- [x] Migration `0026_desk_commentaries` + schema
- [x] Parser + ingest + scheduler (~30 min catch-up)
- [x] Wire desk pack into `generateBrief`
- [x] Admin routes: list / ingest / soft-context
- [ ] User: paste new Apps Script + 15‑min trigger
- [ ] Run migrate + full historical ingest once
- [ ] Optional: surface soft-context in Live / regime UI

### Ops
See `.agents/context/desk-commentaries.md`.
