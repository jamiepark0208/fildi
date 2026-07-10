# polygon-av-backfill-completion

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P2 |
| **Area** | data |
| **Effort** | M (ops + small script fixes; no FIELD_DEFS priority changes) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [data-freshness](23-data-freshness-monitoring-070926.md), [job-queue](28-job-queue-background-workers-070926.md) (P3 backlog), L-01 / L-04 |
| **Type** | ENHANCE (run + harden existing scripts) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — prior audit was thin |

### Purpose
Populate bronze `polygon_fundamentals` / `av_fundamentals` so merge-trusted + provenance can cross-validate — pipeline designed for multi-source; execution stalled after FMP/Yahoo/Finnhub/EDGAR.

### Cache / DB compliance
Tier A bronze tables + `source_fundamentals` via existing populate/merge path. Respect **AV 25/day** (`MAX_DAILY_CALLS` + cursor) and **Polygon ~5/min** (12s sleep). Use `checkDailyBudget` / `recordApiUsage` where scripts already do. **No** Redis. **No** pg-boss until enh/28 approved — cron / manual `tsx` is fine for Phase B. **Do not** change FIELD_DEFS priorities without trader sign-off.

---

## 1. Executive summary (rescoped)

**Already present (do not rewrite clients from scratch):**
- `backfill-polygon.ts` — dry-run, skip when Yahoo+Edgar cover check fields, inserts `polygonFundamentals`, 12s sleep, logs under `logs/`
- `backfill-av.ts` — resumable `logs/av-cursor.json`, **25/day hard stop**, 7d staleness skip, inserts `avFundamentals`, `recordApiUsage`
- `test-av-polygon.ts` — smoke fetch without full universe
- `populate-source-fundamentals.ts` — loads polygon/av bronze → `source_fundamentals`
- `merge-trusted.ts` FIELD_DEFS — **already lists `polygon` and `alpha_vantage`** on many fields (pe, margins, debt, revenue, …)
- `backfill-fundamentals.ts` — separate path that also calls Polygon/AV into merged row (not a substitute for bronze fill)

**Stale comment to fix:** `backfill-av.ts` L12–13 claims AV “not yet wired into merge-trusted FIELD_DEFS” — **false** as of 2026-07-09; update comment when touching script.

**Do:**
1. Phase A — Dry-run 5 tickers each; confirm API keys; fix mapping bugs only
2. Phase B — Run AV rotation daily (25/day) + Polygon batches until bronze counts > 0 (enh/23 will surface counts)
3. Phase C — `populate-source-fundamentals` (or equivalent) + `merge-trusted` for affected tickers; verify provenance shows polygon/av
4. Schedule: shell cron / documented runbook until enh/28 job-queue

**Do not:** websocket; change FIELD_DEFS order; exceed AV 25; invent Redis queue.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Bronze empty → dead merge paths | enh/23 gap G1; populate script expects polygon/av rows |
| Scripts exist | backfill-polygon.ts / backfill-av.ts headers document run commands |
| AV hard limit | `MAX_DAILY_CALLS = 25` L33; quota_stop L108–109 |
| Polygon rate | `BATCH_SLEEP_MS = 12000` L32 |
| FIELD_DEFS already includes sources | merge-trusted L38–88 |
| Job queue deferred | INDEX enh/28 P3 backlog |

---

## 3. What (build scope)

### Phase A — Audit / dry-run
| # | Work |
|---|---|
| A1 | `npx tsx …/backfill-av.ts --dry-run` + polygon `--dry-run` (5 tickers if flag supports; else short registry slice) |
| A2 | Fix field mapping / skip-logic bugs only |
| A3 | Correct stale AV header comment re FIELD_DEFS |
| A4 | Confirm `POLYGON_API_KEY` / `ALPHA_VANTAGE_API_KEY` in env docs |

### Phase B — Populate bronze
| # | Work |
|---|---|
| B1 | Run AV until cursor `done` or multi-day rotation through registry |
| B2 | Run Polygon for tickers not skipped by Yahoo+Edgar coverage |
| B3 | Verify `SELECT count(*) FROM polygon_fundamentals` / `av_fundamentals` > 0 |

### Phase C — Merge + provenance
| # | Work |
|---|---|
| C1 | populate-source-fundamentals (or documented merge path) |
| C2 | merge-trusted for backfilled set |
| C3 | Spot-check StockDB provenance UI for polygon/av sources |
| C4 | enh/23 bronze badges go green |

### Out of scope
| Item | Reason |
|---|---|
| FIELD_DEFS priority changes | Trader sign-off required |
| Real-time Polygon websocket | Forbidden |
| pg-boss / Redis | enh/28 / enh/29 |
| AV beyond OVERVIEW | Forbidden v1 |
| Hardcoded ticker count 257 | Use registry `fetch_fundamentals=true` |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Polygon script | `artifacts/api-server/src/scripts/backfill-polygon.ts` |
| AV script | `backfill-av.ts` — cursor + 25/day |
| Clients | `polygon-client.ts`, `alpha-vantage-client.ts` + `logApiCall` |
| FIELD_DEFS | polygon + alpha_vantage in priority lists |
| Budget helper | `checkDailyBudget` in `api-usage.ts` L27–38 |
| Data-agent waterfall | L-04 — cheapest source first; AV gated |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `scripts/backfill-av.ts` / `backfill-polygon.ts` | Fix bugs + stale comment; run |
| **P1** | Runbook under `.cursor/` or script README | Cron until job-queue |
| **P1** | enh/23 UI | Consumes bronze counts (separate PR ok) |
| — | `merge-trusted.ts` FIELD_DEFS | Prefer **no** priority edits |
| — | enh/28 | Soft schedule only |

### 4.3 Files to read but **not** modify (unless bug)

| Path | Why |
|---|---|
| `populate-source-fundamentals.ts` | Bronze → source_fundamentals |
| `backfill-fundamentals.ts` | Different merged-row path — don’t confuse |
| data-agent / caching-patterns skills | Waterfall |

### 4.4 Paste-ready run commands

```bash
cd artifacts/api-server
npx tsx src/scripts/backfill-av.ts --dry-run
npx tsx src/scripts/backfill-av.ts          # stops at 25/day
npx tsx src/scripts/backfill-polygon.ts --dry-run
npx tsx src/scripts/backfill-polygon.ts
# then populate + merge per existing scripts
```

### 4.5 Acceptance criteria

- [ ] `polygon_fundamentals` count > 0 and `av_fundamentals` count > 0 (or documented partial with AV multi-day plan)
- [ ] AV never exceeds 25 calls/day (`api_usage` / cursor)
- [ ] Polygon respects ~5/min pacing
- [ ] Provenance UI can show polygon and/or alpha_vantage for ≥1 field on a sample ticker
- [ ] No FIELD_DEFS priority changes without sign-off
- [ ] Stale AV header comment fixed
- [ ] No Redis / pg-boss required for Phase B

### 4.6 Suggested commit messages

`fix(data): correct AV backfill docs; harden skip/mapping`  
`chore(data): document polygon/AV backfill runbook`  
(ops runs may not need commits)

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| **enh/23** | Soft — bronze counts in admin UI |
| **enh/28** | Soft — later schedule; not blocking manual/cron |
| API keys | Hard |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- Bronze tables + provenance divergence rates may rise (expected)
- Rollback: stop scripts; bronze rows harmless if unused

### 2. Bug introductions
- AV budget overrun if cursor bypassed — never remove hard stop
- Polygon symbology mismatches — use registry / source_ticker_map
- Running merge with empty bronze still no-ops — populate first
- Catch: dry-run logs; after run counts > 0; api_usage av ≤ 25

### 3. Performance
- Multi-day AV for full registry (~257/25 ≈ 11 days) — document ETA
- Polygon slower due to 12s sleep + skip logic

### 4. Workflow
- Ops: daily AV cron; weekly Polygon catch-up until full

### 5. Drift
- Paired: bronze fill ↔ populate ↔ merge-trusted ↔ enh/23 health ↔ L-04 waterfall

**Do not:** change FIELD_DEFS order; websocket; Redis queue; hardcode 257.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready  
**Was:** ready thin audit. **Key:** scripts + FIELD_DEFS already exist; work is run/harden + populate/merge — not greenfield; AV header comment is stale.
