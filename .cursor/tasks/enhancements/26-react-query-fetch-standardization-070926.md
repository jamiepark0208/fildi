# react-query-fetch-standardization

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P2 |
| **Area** | api / ui |
| **Effort** | M (narrow: keys + defaults + 2–3 hot paths) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [openapi-orval](22-openapi-coverage-orval-migration-070926.md), [watchlist-monitor](16-watchlist-monitor-improvements-070926.md) |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — prior audit thin |

### Purpose
One React Query convention so home → scanner → watchlist don’t triple-fetch the same rankings/quotes with incompatible keys. Client cache as a first-class layer — not a second server cache (see enh/29 Redis defer).

### Cache / DB compliance
Client-only. No Redis. No new TTLCache. Prefer aligning with Orval-generated query keys **after** enh/22 migrates a page — don’t invent parallel key trees for the same endpoint.

---

## 1. Executive summary (rescoped)

**Already present:**
- `QueryClient` in `App.tsx` L23–29 — `retry: 1`, `refetchOnWindowFocus: false`, **no default `staleTime`**
- Home: `["fundamentals-rankings"]` staleTime **5m**; peer-groups 24h; macro-regime 1h (`home.tsx` L51–113)
- Scanner: `["fundamentals", "rankings"]` staleTime **Infinity**; `["technicals", "all"]` Infinity; options `["options", ticker]` 5m; regime `["macro", "regime"]` 5m (`options-scanner.tsx` L729–822)
- Watchlist: Orval `getGetStockQuoteQueryOptions` + `["watchlist"]` Infinity (`use-watchlist.ts`)
- **Key mismatch:** home `fundamentals-rankings` ≠ scanner `fundamentals/rankings` — **cannot share cache today**

**Do (narrow Phase A):**
1. Add `artifacts/stock-compare/src/lib/query-keys.ts` with factories + documented staleTime tiers
2. Set App default `staleTime: 5 * 60_000` (INTRADAY) — pages with Infinity/STATIC override explicitly
3. **Align fundamentals rankings key** between home and scanner (pick one canonical key; update both)
4. Align macro regime key if both fetch same payload (`macro-regime` vs `macro/regime`)
5. Sort ticker arrays before keying options/multi-ticker queries
6. Optional: React Query Devtools behind `import.meta.env.DEV`

**Defer full-app migration** and raw→Orval to enh/22 (macro first). This task is **keys + defaults + hot-path alignment**, not rewriting every fetch.

**Do not:** localStorage persistence plugin; SWR; share keys across different response shapes.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Duplicate rankings fetches | Different keys home vs scanner |
| No global staleTime | App.tsx L23–29 |
| Scanner Infinity on rankings | L816–822 — never shares with home’s 5m entry |
| Orval partial | enh/22 — generated keys will dominate migrated pages |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | `lib/query-keys.ts` + short comment block for LIVE/INTRADAY/DAILY/STATIC |
| W2 | App.tsx default staleTime 5m |
| W3 | Unify home + scanner fundamentals rankings to same key + compatible staleTime (prefer 5m INTRADAY, not Infinity, unless product requires) |
| W4 | Unify regime query key if URLs match |
| W5 | Document: after Orval migrate, prefer `getXQueryKey()` from client over hand keys |

### Out of scope
| Item | Reason |
|---|---|
| Migrate all raw fetch | enh/22 |
| Persist QueryClient to localStorage | Forbidden v1 |
| Server Redis | enh/29 deferred |
| Feed/social key rewrite | Keep short stale; separate namespace |
| Devtools in production | DEV only |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| App defaults | App.tsx L23–29 — no staleTime |
| Home rankings key | `["fundamentals-rankings"]` L107, stale 5m |
| Scanner rankings key | `["fundamentals", "rankings"]` L816, Infinity |
| Scanner options | `["options", ticker]` L768, 5m |
| Watchlist | `QUERY_KEY = ["watchlist"]` |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/lib/query-keys.ts` | **New** |
| **P0** | `artifacts/stock-compare/src/App.tsx` | default staleTime |
| **P0** | `pages/home.tsx` | use queryKeys |
| **P0** | `pages/options-scanner.tsx` | align rankings (+ regime) keys |
| **P1** | `hooks/use-watchlist.ts` | export key via factory (optional) |
| — | macro.tsx | Prefer enh/22 Orval first |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| enh/22 pack | Orval key ownership |
| Orval `getGetStockQuoteQueryKey` | Canonical for quotes |
| caching-patterns skill | Server TTL — different layer |

### 4.4 Paste-ready key factory

```ts
/** Client React Query keys — sort tickers before including in keys. */
export const queryKeys = {
  watchlist: ["watchlist"] as const,
  fundamentalsRankings: ["fundamentals", "rankings"] as const, // canonical — update home
  technicalsAll: ["technicals", "all"] as const,
  options: (ticker: string) => ["options", ticker.toUpperCase()] as const,
  macroRegime: ["macro", "regime"] as const,
  peerGroups: (tickers: string[]) => ["peer-groups", [...tickers].sort()] as const,
};

export const STALE = {
  LIVE: 30_000,
  INTRADAY: 5 * 60_000,
  DAILY: 60 * 60_000,
  STATIC: 24 * 60 * 60_000,
} as const;
```

### 4.5 StaleTime tiers (document in file header)

| Tier | staleTime | Examples |
|---|---|---|
| LIVE | 30s | live quotes if polled |
| INTRADAY | 5m | options chain, rankings (aligned), default App |
| DAILY | 1h | macro regime (if daily-ish) |
| STATIC | Infinity / 24h | scorecard guide, watchlist list |

### 4.6 Acceptance criteria

- [ ] `query-keys.ts` exists and is used by home + scanner for rankings
- [ ] Network: home → scanner does **not** refetch fundamentals rankings if within staleTime (same key)
- [ ] App default staleTime set; Infinity overrides remain intentional and commented
- [ ] No shared key across different response shapes
- [ ] Tickers sorted in multi-ticker keys
- [ ] stock-compare typecheck
- [ ] No Redis / persistence plugin

### 4.7 Suggested commit message

`refactor(web): unify React Query keys for rankings and defaults`

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| **enh/22** | Soft — Orval pages should adopt generated keys; do rankings align **before or with** macro migration |
| enh/29 | Anti-dep — do not pull Redis in |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- home + scanner query identity; brief flash of refetch on deploy once
- Rollback: revert keys

### 2. Bug introductions
- Unifying key with **different JSON shapes** → silent wrong UI — verify both hit same endpoint
- Changing Infinity → 5m increases refetch — acceptable; document
- Orval later regenerates different keys — migration note in query-keys.ts
- Catch: Devtools shows one rankings query shared after navigation

### 3. Performance
- 1–3 fewer duplicate fetches per session (modest — still worth for correctness)

### 4. Workflow
- Snappier home↔scanner; fewer rate-limit hits on rankings API

### 5. Drift
- Paired: query-keys ↔ Orval getXQueryKey ↔ App defaults ↔ server TTL (separate)

**Do not:** persist cache; collide shapes; full-app rewrite; Redis.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready (narrow)  
**Was:** ready with thin audit. **Key:** home `fundamentals-rankings` vs scanner `fundamentals/rankings` is the smoking gun; fix keys + App staleTime — leave Orval bulk to enh/22.
