# technical-scorecard-improvements

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | ui |
| **Effort** | M (Phase A); alerts = v2 stub only |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Research** | [feature-purpose-research](1-feature-purpose-research-070926.md) |
| **Related** | [scanner-simplified-view](../new_app_features/5-scanner-simplified-view-070926.md), [contextual-score-explanations](../new_app_features/3-contextual-score-explanations-070926.md), [ai/11](../ai/11-product-ai-explain-csp-070926.md), [feed Validate CTA](13-feed-improvements-070926.md) |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — was thin draft |

### Purpose
Time CSP entries — know when technicals favor selling puts vs waiting, then hand off to the scanner without re-reading RSI bars.

### Cache / DB compliance
Reuse existing technical/scorecard paths + `computeTechnicalRankingsV2` (client). No new Yahoo indicator fetches. No new TTLCache. No Redis alerts. No cron.

---

## 1. Executive summary (rescoped)

**Already present (do not rebuild):**
- `/technical` — `TechnicalCards`, `TechnicalLeaderboard`, `TechnicalMetricsTable` in `technical.tsx`
- `SignalBadge` already shows **GO / WATCH / NO** (L39–48, L185)
- `computeTechnicalRankingsV2` already emits `signal` + `reason` via `generateReasonV2` (`technical-rankings.ts` L283–390)
- Leaderboard “Why” already POSTs to `/api/explain/score` with `score.reason` in payload (L325–351) — **card UI never shows `reason`**

**Do (Phase A):**
1. Surface **entry verdict** = existing `signal` + one-line `reason` on cards (and optionally metrics table footer) — map copy Favorable↔GO, Wait↔WATCH/NO if product wants friendlier labels, but **keep gate enum unchanged**
2. **Open in scanner** link per ticker (table + card) → `/options-scanner?ticker=X` (scanner must read query — **today it does not**)
3. Do **not** invent a second scoring path or Favorable/Neutral/Wait math

**v2 (out of Phase A build):** localStorage RSI threshold prefs UI stub only — no background worker until job-queue approved.

Coordinate scanner deep-link with [enh/13](13-feed-improvements-070926.md) / [enh/12](12-stock-breakdown-sections-improvements-070926.md) so one query-param contract.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Signal already on cards | `SignalBadge` L39–48; used L185 with `ts?.signal ?? d.signal` |
| Reason computed, not shown | `generateReasonV2` L283+; assigned L390; UI only passes to explain body L351 — no card subtitle |
| Metrics table has Signal row | L538–554 — no scanner CTA column |
| Scanner ignores URL ticker | `options-scanner.tsx` — no `URLSearchParams` / `useSearch` for ticker |
| Scoring is self-relative V2 | `computeTechnicalRankingsV2` L314–400 — do not change |

---

## 3. What (build scope)

### Phase A — in scope
| # | Work |
|---|---|
| A1 | Card: show `ts.reason` (or truncated) under SignalBadge when `TechnicalScore` present |
| A2 | Optional friendlier label map for display only: GO→“Favorable”, WATCH→“Wait”, NO→“Avoid” — **or** keep GO/WATCH/NO; pick one in PR (prefer keep enum, add reason line) |
| A3 | Card + metrics header: “Scanner” link → `/options-scanner?ticker={T}` |
| A4 | `options-scanner.tsx`: on mount, if `?ticker=` present, seed focus/filter/search for that ticker (document exact UX in PR — e.g. highlight row or set search) |
| A5 | Shared helper optional: `lib/scanner-deep-link.ts` `scannerHref(ticker)` used by technical, feed, breakdown |

### Phase B / v2 — deferred
| # | Work |
|---|---|
| B1 | localStorage prefs for RSI alert thresholds — UI only |
| B2 | No cron / job-queue pollers |

### Out of scope
| Item | Reason |
|---|---|
| Recompute / fork `computeTechnicalRankingsV2` | Forbidden |
| New indicator Yahoo paths | Forbidden |
| Redis / push alerts | Forbidden |
| Duplicate explain API | Use existing `/api/explain/score`; richer copy = new_app_features/3 + ai/11 |
| Multi-TF TradingView alerts | Competitor research only |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Page | `artifacts/stock-compare/src/pages/technical.tsx` — cards L90–299, leaderboard L303–464, table L519–634 |
| Gate | `computeGateV2` L247–279 — GO needs RSI/MFI/stoch + MACD/vel + no knife + no earnings≤7d |
| Reason | `generateReasonV2` L283+ — `${signal} · ${regime}` + RSI pct + MACD |
| Shelf tickers | App `useSessionState("fildi_tickers")` shared with Home |
| Sidebar | Technical in nav (`sidebar.tsx`) |

### 4.2 Files to modify (Phase A)

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/pages/technical.tsx` | Reason line on cards; scanner links on cards/table |
| **P0** | `artifacts/stock-compare/src/pages/options-scanner.tsx` | Read `?ticker=` and apply focus |
| **P1** | Optional `artifacts/stock-compare/src/lib/scanner-deep-link.ts` | Shared href builder |
| — | `lib/technical-rankings.ts` | Prefer **no** change |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `technical-rankings.ts` gate/reason | Contract for display copy |
| new_app_features/3, ai/11 | Explain richness — don’t fork |
| enh/12, enh/13 | Same scanner query contract |

### 4.4 Paste-ready display mapping (optional)

```ts
const VERDICT_LABEL: Record<"GO" | "WATCH" | "NO", string> = {
  GO: "Favorable",
  WATCH: "Wait",
  NO: "Avoid",
};
// Prefer showing SignalBadge as-is + reason subtitle:
// <p className="text-[10px] text-muted-foreground line-clamp-2">{ts.reason}</p>
```

### 4.5 Scanner deep-link contract

| Param | Behavior |
|---|---|
| `?ticker=AAPL` | Uppercase; if invalid/empty ignore; else set scanner search/highlight |
| Missing | Current default |

### 4.6 Acceptance criteria

- [ ] Card shows one-line why from existing `reason` when score present
- [ ] Scanner link navigates with ticker query
- [ ] Scanner consumes `?ticker=` (manual verify)
- [ ] No change to `computeTechnicalRankingsV2` math
- [ ] No new indicator fetches / TTLCache / Redis
- [ ] stock-compare typecheck
- [ ] Alerts (if any UI) are prefs-only stub — no workers

### 4.7 Suggested commit message

`feat(technical): show gate reason on cards and scanner deep-link`

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| **options-scanner query support** | Soft — implement in same PR or tiny precede |
| new_app_features/5 | Scanner UX polish — don’t block Phase A |
| new_app_features/3 / ai/11 | Explain depth — separate |
| enh/12, enh/13 | Shared `?ticker=` contract |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- technical.tsx UI + options-scanner mount path
- Rollback: revert those two files

### 2. Bug introductions
- Friendlier labels that diverge from scanner GO/WATCH/NO → trader confusion — prefer keep enum + reason
- Scanner `?ticker=` races with default universe load — apply after data ready
- Catch: GO ticker shows reason containing “GO ·”; link opens scanner with ticker

### 3. Performance
- No new fetches; reason already on `TechnicalScore`

### 4. Workflow
- Technical → scanner handoff for CSP entry timing

### 5. Drift
- Paired: technical reason display ↔ explain payload ↔ scanner signal column

**Do not:** new scoring; Yahoo paths; Redis alerts; cron.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready  
**Was:** draft. **Key:** SignalBadge + `reason` already exist — surface reason; add scanner `?ticker=` (scanner currently ignores query).
