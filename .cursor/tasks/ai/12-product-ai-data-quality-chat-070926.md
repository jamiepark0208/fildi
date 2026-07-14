# product-ai-data-quality-chat

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | ui (+ thin API only if FAQ needs it — prefer none) |
| **Effort** | M (~1–2 sessions; templates-first) |
| **Created** | 2026-07-09 |
| **Source** | agentic-workflow-research |
| **Research** | [agentic-workflow-research](1-agentic-workflow-research-070926.md) — floors **R3**, **R6**, **R9**, **R10** |
| **Related** | [data-freshness-monitoring](../enhancements/23-data-freshness-monitoring-070926.md), StockDBTab, fundamentals-provenance |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Admins ask “why is this field wrong / stale?” **in context of** Stock DB / freshness — answers cite provenance rows, not vibes.

### Cache / DB compliance
Reuse `GET /api/fundamentals/provenance/:ticker` (+ future `GET /api/admin/data-health`). Prefer **structured answers from APIs** first; LLM optional only to phrase cited facts. No DB dump into prompts. Admin-only. `provenanceCache` semantics unchanged (invalidate on override already).

---

## 1. Executive summary (rescoped)

**Do not** build a free-form SQL / “ask the database” agent.

**Do** add a **templates-first FAQ panel** on StockDBTab for the selected/hovered ticker, answering from the existing provenance JSON (`{ ticker, fields[] }`). Wire stale/health questions only after enhancements/23 ships `data-health`. Optional Haiku formatter **off by default**.

---

## 2. Why (requirements gathered)

| Requirement | Source | Notes |
|---|---|---|
| Dense provenance tables hard to query | User / research | “Which source won for PE?” |
| Cite sources | Competitive (Notion/Glean) | Must match table |
| Admin-only | Provenance routes use `requireAdmin` | Same gate |
| No live FMP from chat | Cache/DB rules | Use cached provenance / health aggregates |
| Templates before LLM | Cost / hallucination | R3/R9 |
| No vector index of fundamentals | R6 | SKIP |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | FAQ / ask panel on StockDBTab scoped to one ticker |
| W2 | Context = provenance payload only (+ data-health when exists) |
| W3 | Answers show field + winningSource + override citations |
| W4 | Template FAQ for: source of field, overrides, divergent, (later) stale |
| W5 | Admin-only UI (tab already admin settings) + API already requireAdmin |
| W6 | Refuse “all tickers” / dump prompts |

### Out of scope
| Item | Reason |
|---|---|
| Free-form SQL agent | Leak + cost |
| Non-admin trader DQ chat v1 | Provenance is admin |
| Vector index | R6 |
| Auto-remediation / auto-override | Dangerous |
| Second provenance API | Reuse GET |
| Implementing data-health | enhancements/23 |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Provenance GET admin | `fundamentals-provenance.ts` L116 — `requireAdmin`; path `/fundamentals/provenance/:ticker` |
| Cache | `provenanceCache.get/set` L119–120, L202; delete on override L248/L282 |
| Payload shape | `{ ticker, fields }` — each field: `winningSource`, `winningValue`, `isOverride`, `divergent`, `override`, `sources[]` (L184–201) |
| StockDBTab already fetches provenance | `StockDBTab.tsx` L282–292 — `GET /api/fundamentals/provenance/${hoveredTicker}` on hover; queryKey `["provenance", hoveredTicker]` |
| FieldProv types in UI | L54–64 `FieldProv` / `ProvenanceData` |
| Override invalidates provenance query | L310–312 |
| data-health API | **Not built** — enhancements/23 owns `GET /api/admin/data-health` |
| Chat / FAQ panel | **Absent** on StockDBTab today |

### 4.2 Files to modify (authoritative)

| Priority | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/components/settings/StockDBTab.tsx` | FAQ panel; reuse `provData` / refetchProv; no new fetch storm |
| **P0** | Optional `…/settings/StockDBFaqPanel.tsx` or `lib/provenance-faq.ts` | Pure functions: question → answer from `ProvenanceData` |
| **P1** | Optional Haiku formatter | Flag default **off**; input = JSON subset only |
| **P2** | After enhancements/23 | Stale/health FAQ using data-health JSON |
| — | `fundamentals-provenance.ts` | Prefer **no** change |
| — | SQL agent / dump-all | **Forbidden** |

### 4.3 Files to read but **not** modify (unless bug)

| Path | Why |
|---|---|
| `artifacts/api-server/src/routes/fundamentals-provenance.ts` | Payload + auth SSOT |
| `artifacts/api-server/src/lib/provenance-cache.js` (or `.ts`) | TTL semantics |
| `scripts/merge-trusted.ts` FIELD_DEFS | Field name vocabulary |
| enhancements/23 | Health shape when wiring stale |
| ai/2 / ai/5 | No secret dump; no DB MCP |

### 4.4 FAQ template map (spec)

| User ask (examples) | Answer from |
|---|---|
| “What sourced {field}?” / “Who won for pe?” | `fields.find(f => f.field === X).winningSource` + `winningValue` + `sources` status |
| “Any overrides?” | `fields.filter(f => f.override \|\| f.isOverride)` |
| “Divergent fields?” | `fields.filter(f => f.divergent)` |
| “Stale?” | **Defer** until data-health; until then: show `fetchedAt` on field/sources only |
| “Dump all tickers / run SQL” | Hard refuse string; no extra network |

**Algorithm:**
```
ticker = hoveredTicker || selectedTicker
if !ticker: prompt “hover/select a ticker”
ensure provData for ticker (existing query) — do not N+1 FMP
match intent → template render citing JSON keys only
optional LLM: only format template facts; never invent fields not in JSON
```

### 4.5 Acceptance criteria

- [ ] Non-admin: provenance still 403; panel not usable without admin session
- [ ] “What sourced PE?” (or real field key) matches provenance popover/table for same ticker
- [ ] After override, chat/FAQ uses invalidated/refetched provenance (same as UI)
- [ ] Templates work with LLM **off**
- [ ] “Dump DB” / “all tickers” refused; no extra live FMP from chat
- [ ] No new provenance route; no Redis memory
- [ ] No writes to `.cursor/context/lessons.md`

### 4.6 Suggested commit message

`feat(admin): Stock DB provenance FAQ panel (templates-first)`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| **enhancements/23** | Soft for stale questions; ship templates without it |
| Provenance API | Hard — already exists |
| ai/1 R3/R6/R9 | Floors |

---

## 5. Data / cache
- Existing provenanceCache; no N+1 live vendor from chat
- data-health when ready — aggregates only

## 6. Impact & Risk Analysis

- Citations must use an invalidated query after an override, or they show stale data
- LLM must be templates-first and constrained to FIELD_DEFS/COLS keys from the UI — don't let it invent field names
- Scoped to StockDBTab (+ optional small helper), one ticker max, no universe prompts
- Paired with provenance table ↔ FAQ ↔ FIELD_DEFS — a payload shape change must update the FAQ map

**Do not:** SQL agent; DB dump; Redis memory (R6, R9).  
**Floors:** R3, R6, R9, R10.

---

## Review: APPROVE — ready (templates-first; health later). FAQ over existing provenance JSON on StockDBTab; reuse hover query; no new API; no SQL agent.
