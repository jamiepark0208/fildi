# product-ai-trade-journal-loop

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | ui / data |
| **Effort** | L (Phase 0 design **required** before migration) |
| **Created** | 2026-07-09 |
| **Source** | agentic-workflow-research |
| **Research** | [agentic-workflow-research](1-agentic-workflow-research-070926.md) — floors **R3**, **R5**, **R8**, **R9**, **R10** |
| **Related** | [feed-improvements](../enhancements/13-feed-improvements-070926.md), [portfolio-analysis-improvements](../enhancements/8-portfolio-analysis-improvements-070926.md), [portfolio-daily-brief](../enhancements/9-portfolio-daily-brief-improvements-070926.md), [profile-track-record](../enhancements/14-profile-track-record-improvements-070926.md), [ai/3](3-agentic-lesson-memory-hygiene-070926.md), [ai/14](14-product-ai-trader-account-research-070926.md) (**system** AI memory — co-design tag vocab; do not merge human P&L into AI train) |
| **Type** | ENHANCE (+ NEW schema only if design says so) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Closed trades become **structured learning** (tags + outcomes + optional AI summary of *user-written* thesis) — like Fin’s improve loop, not fine-tuning.

### Cache / DB compliance
Enhance feed close + portfolio journal draft. **Design schema before migration.** No Redis. No second LLM brief pipeline — reuse daily-brief patterns if narrative needed. Dev `.cursor/context/lessons.md` must **never** receive trade PII (**ai/3**, R5).

---

## 1. Executive summary (rescoped)

**Do not** fine-tune, auto-trade, or write agent lessons from trades.

**Do** Phase 0: agree journal tag/outcome fields with [enhancements/8](../enhancements/8-portfolio-analysis-improvements-070926.md) (single migration owner). Then extend feed close beyond `{ closePremium }` with **optional** tags + notes; profile shows tagged rates with honest **n**; retrieve similar via SQL; optional click-only summarize of **notes only**.

---

## 2. Why (requirements gathered)

| Requirement | Source | Notes |
|---|---|---|
| P&L without “why wrong” | User problem | Repeat CSP mistakes |
| Mistake tags | Edgewonk / enhancements/8 | “Journal tags \| NEW \| Schema plan first” |
| Human-steered | R8 | No silent weight updates |
| Separate from Cursor lessons | R5 / ai/3 | Hard ban |
| No second daily-brief LLM | enhancements/9 | Link only |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W0 | **Phase 0 design** — tables/fields vs reuse `trade_posts`; agree with enh/8 |
| W1 | Schema + Drizzle migration (nullable tags/outcome) after approval |
| W2 | Feed close UX: optional tag chips + notes (keep fast) |
| W3 | Profile: tagged mistake rates with sample size **n** |
| W4 | Similar past mistakes — deterministic SQL first |
| W5 | Optional AI: summarize **user notes** on confirm — notes-only prompt |

### Out of scope
| Item | Reason |
|---|---|
| Fine-tune on trades | SKIP |
| Auto-trading from journal | R8 |
| Writing `.cursor/context/lessons.md` | R5 / ai/3 |
| Second daily-brief LLM | enhancements/9 |
| TipRanks import | Out of scope |
| Required tags blocking close v1 | Prefer optional |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Close API body | `feed.ts` L258–261 — `PATCH /feed/posts/:id/close`; destructures `{ closePremium }` only |
| Close validation | L268–269 — non-negative `closePremium` required |
| PnL formula | L271 — `(premiumPerContract - closePremium) * contracts * 100` |
| UI close form | `TradeCard.tsx` L301–332 — premium input only; `onClose(closePremiumNum)` |
| `trade_posts` columns | `lib/db/src/schema/index.ts` L466–493 — has `notes`, `closePremium`, `resolvedPnl`, **no** journal tags / outcome enum / mistake tags |
| Profile aggregates | `feed.ts` ~L397+ profile route — closed counts exist; no tag rates |
| enhancements/8 | Explicit gap: “journal tags” NEW — schema plan first |
| lessons.md | Must stay untouched by product journal (**ai/3**) |

### 4.2 Phase 0 design checklist (block migration until checked)

- [ ] Single owner: this task vs enhancements/8 — **one** migration
- [ ] Storage choice: columns on `trade_posts` (e.g. `journalTags text[]` / jsonb, `journalOutcome`, `closeNotes`) **vs** new `trade_journal_entries` table
- [ ] Tag vocabulary v1 (fixed enum chips, not free tags) — list 5–10 mistake types
- [ ] Optional vs required on close — **recommend optional**
- [ ] Privacy: summarize prompt = notes text only; redact size/account/premium if notes pasted carelessly
- [ ] Indexes: `(user_id, …)`, `(ticker, resolved_at)` for retrieve
- [ ] Confirm daily-brief does **not** invent tags

### 4.3 Files to modify (after design approval)

| Priority | Path | Change |
|---|---|---|
| **P0** | `lib/db/src/schema/index.ts` + Drizzle migration | Nullable journal fields |
| **P0** | `artifacts/api-server/src/routes/feed.ts` | Accept tags/outcome/notes on close (backward compatible) |
| **P0** | `artifacts/stock-compare/src/components/TradeCard.tsx` | Optional tag chips in close form |
| **P1** | Profile UI + feed profile aggregates | Mistake rates with **n** |
| **P1** | Retrieve endpoint or query | `WHERE user_id AND tag … LIMIT 5` |
| **P2** | Optional summarize route | Click-only Haiku; notes-only body |
| — | `.cursor/context/lessons.md` | **Never** |
| — | enhancements/9 brief pipeline | Link only — no fork |

### 4.4 Files to read but **not** modify during Phase 0

| Path | Why |
|---|---|
| `lib/db/src/schema/index.ts` tradePosts | Current columns |
| `feed.ts` close handler | Extension point |
| `TradeCard.tsx` close UI | UX extension point |
| enhancements/8, 13, 14 | Align fields / avoid double schema |
| ai/3 Memory map | Journal ≠ lessons |

### 4.5 Close + learn algorithm (spec)

```
Close (v1):
  body: { closePremium, journalTags?: string[], journalOutcome?: string, closeNotes?: string }
  persist; compute resolvedPnl as today
  tags optional — empty OK

Retrieve similar:
  same userId; match tag and/or ticker; order by resolved_at desc; LIMIT 5
  show in open-trade or profile context — deterministic

Summarize (optional):
  user clicks “Summarize my notes”
  prompt input = closeNotes / notes only
  never auto-run on close; never dump full position book
```

### 4.6 Acceptance criteria

- [ ] Phase 0 checklist complete **before** migration PR
- [ ] Close without tags still works (backward compatible)
- [ ] Close with tags persists; visible on profile with **n**
- [ ] `git status` / wrap: `.cursor/context/lessons.md` unchanged by journal feature
- [ ] Summarize (if shipped) notes-only; click-only
- [ ] No fine-tune; no auto-trade
- [ ] Single migration agreed with enhancements/8

### 4.7 Suggested commit message (after design)

`feat(feed): optional journal tags on trade close`  
(Phase 0 may be docs-only commit first)

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| **enhancements/8** | **Hard** — journal tags schema co-design |
| enhancements/13 / 14 | Feed/profile UX |
| enhancements/9 | Brief link only |
| **ai/3** | Never write lessons.md |

---

## 5. Data sources & API
- Extend feed close; migration via Drizzle only when approved
- No Redis

## 6. Caching
- No hot-path cache required; profile aggregates OK with short TTL later

## 7. Agent routing
- data-agent: migration scaffold; ui-agent: close UX; verify via ai/9

---

## Impact & Risk Analysis

### 1. Blast radius
- feed close, schema, TradeCard, profile; optional summarize
- Rollback: hide UI; nullable columns; flag summarize

### 2. Bug introductions
- Mis-tagged outcomes — allow edit; show n
- PII to model vendor — notes-only; redact
- Journal conflated with agent lessons — hard ban + ai/3
- Double-close — existing feed semantics
- Catch: tagged close → profile; lessons.md clean

### 3. Performance & cost
- Tag write: single UPDATE  
- Retrieve &lt;50ms indexed  
- AI click-only  

### 4. Workflow
- Before: close = premium + PnL  
- After: optional reflection chips  
- Prefer optional tags v1

### 5. Drift
- Paired: feed ↔ portfolio journal ↔ profile ↔ **not** lessons.md
- One schema owner

### 6. Scalability
- User-scoped similar mistakes v1  
- No cross-user without privacy design

**Do not:** fine-tune; auto-trade; write lessons.md (R5, R8).  
**Floors:** R3, R5, R8, R9, R10.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — **Phase 0 first**  
**Need:** Tags on close + learning loop; schema with enh/8.  
**Better:** Close is PnL-only today (`closePremium`); no tags on `trade_posts` yet.
