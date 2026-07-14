# command-palette-navigation

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P2 |
| **Area** | ui |
| **Effort** | M |
| **Created** | 2026-07-09 |
| **Source** | competitive-research |
| **Research** | [competitive-ux-research](1-competitive-ux-research-070926.md) |
| **Related** | [onboarding-product-tour](2-onboarding-product-tour-070926.md) (Replay tour action), [scanner-simplified](5-scanner-simplified-view-070926.md) / [technical](../enhancements/15-technical-scorecard-improvements-070926.md) (`?ticker=` patterns), [home-dashboard](4-home-dashboard-redesign-070926.md) |
| **Type** | ENHANCE (wire existing cmdk — not new search product) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Jump to any page or ticker without hunting the 12-item sidebar — TradingView-style ⌘K for CSP workflow (scanner / watchlist / breakdown).

### Cache / DB compliance
No new APIs. Pages = static nav config. Watchlist tickers = `useWatchlist()` (local). Ticker search = existing `useSearchStocks` / `GET /api/stocks/search` with **debounce ≥180ms** and **enabled only when query ≥2 chars** (same as watchlist). Recent = `sessionStorage` only. No Redis.

---

## 1. Executive summary (rescoped)

**Already present (do not rebuild):**
- `cmdk` in `package.json` (`^1.1.1`) + shadcn `components/ui/command.tsx` (`CommandDialog`, groups, items)
- Sidebar `DEFAULT_GROUPS` L45–74 with `adminOnly` (portfolio); filter pattern L243
- `useSearchStocks` + debounce pattern in `watchlist.tsx` L55–66
- `App.tsx` `WouterRouter` L119–121 — palette must mount **inside** (same rule as ProductTour)
- No global `CommandPalette` / ⌘K handler on disk

**Do:**
1. Extract `lib/nav-config.ts` from `DEFAULT_GROUPS` — sidebar + palette share one source
2. `CommandPalette` — ⌘K / Ctrl+K; groups: Pages, Recent, Watchlist, Search
3. Mount inside `WouterRouter` + `AuthProvider` (need `isAdmin` + `navigate`)
4. Ticker select → `/watchlist?ticker=NVDA` (add query reader) **or** `/breakdown?ticker=` if breakdown already supports it — prefer watchlist select for CSP monitor job
5. Actions: “Options Scanner”, “Scorecard Guide”; “Replay tour” only if seq 2 shipped (dispatch same helper Settings uses)
6. Hide `adminOnly` pages when `!isAdmin`

**Do not:** add cmdk again; fuzzy-search codebase; “Explain score” action (needs seq 3 context); new ticker route file.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Dense equal-weight nav | `sidebar.tsx` `DEFAULT_GROUPS` L45–74 — Feed, Watchlist, Fundamental, Scanner, Macro, … |
| cmdk unused | `command.tsx` exists; grep: no `CommandPalette` / Meta+k |
| Search already exists | `useSearchStocks` watchlist L57–66; profile also |
| Watchlist no deep-link | `selectedTicker` state L33 — **no** `URLSearchParams` / `?ticker=` |
| Tour replay path | seq 2: Settings Profile “Replay product tour” — palette can call same API |
| Competitor | TradingView / Linear command menu |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | `lib/nav-config.ts` — export groups/items; sidebar imports |
| W2 | `components/CommandPalette.tsx` + keydown Meta/Ctrl+k (ignore when input focused? prefer always — cmdk handles) |
| W3 | Pages group from nav-config; filter `adminOnly` |
| W4 | Watchlist group from `useWatchlist().entries` |
| W5 | Search group when `q.length >= 2` — debounced `useSearchStocks` |
| W6 | Recent tickers `sessionStorage` `fildi_recent_tickers` (max 5) |
| W7 | `watchlist.tsx` — on mount read `?ticker=`, `setSelectedTicker` if in list (else still set / soft-add? **v1: select if present, else ignore**) |
| W8 | Soft action: Replay tour → seq 2 helper |

### Out of scope
| Item | Reason |
|---|---|
| New npm dep / second cmdk | Already installed |
| Explain-score command | seq 3 + context payload |
| Admin pages for members | Filter only |
| `/watchlist/:ticker` route | Query param enough |
| Global app search of posts/notes | Different product |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| cmdk dependency | `package.json` L55 |
| CommandDialog | `components/ui/command.tsx` L26–36 |
| DEFAULT_GROUPS | `sidebar.tsx` L45–74; `adminOnly` on portfolio L53 |
| isAdmin filter | L243 `!item.adminOnly \|\| isAdmin` |
| App routes | `App.tsx` L66–108 — includes `/sentiment` orphan (enh/17) — **include in nav only if still linked**; today **not** in DEFAULT_GROUPS |
| No palette mount | `App.tsx` L113–128 — Router only |
| Watchlist selection | L33 `selectedTicker`; no query read |
| Search debounce | L55 `useDebounce(inputText, 180)` |
| Lessons | none for cmdk/palette |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `lib/nav-config.ts` | **New** — move DEFAULT_GROUPS + types |
| **P0** | `components/sidebar.tsx` | Import nav-config; keep order localStorage merge |
| **P0** | `components/CommandPalette.tsx` | **New** |
| **P0** | `App.tsx` | Mount palette inside `WouterRouter` (and auth) |
| **P0** | `pages/watchlist.tsx` | Read `?ticker=` once on mount |
| **P1** | `lib/recent-tickers.ts` | Optional tiny helper |
| **P2** | Tour replay wire | Only if seq 2 helpers exist |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `components/ui/command.tsx` | Use as-is |
| seq 2 tour-config | Replay action contract |
| enh/15 scanner `?ticker=` | Parallel deep-link pattern — don’t break |
| generated `useSearchStocks` | Orval — don’t hand-edit |

### 4.4 Paste-ready behavior

```
keydown Meta+k | Ctrl+k → preventDefault; setOpen(true)
onSelect page → navigate(href); close
onSelect ticker → push recent; navigate(`/watchlist?ticker=${T}`); close
search: enabled = open && q.trim().length >= 2; debounce 200ms
```

### 4.5 Acceptance criteria

- [ ] ⌘K / Ctrl+K opens palette; Esc closes
- [ ] Typing “scan” surfaces Options Scanner
- [ ] Admin-only Portfolio hidden for non-admin
- [ ] Ticker from search/watchlist lands on watchlist with row selected (`?ticker=`)
- [ ] Search API not called for 0–1 char queries
- [ ] No new dependency; stock-compare typecheck
- [ ] Sidebar still renders after nav-config extract

### 4.6 Suggested commit message

`feat(ui): add ⌘K command palette sharing nav-config with sidebar`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| seq 2 tour | Soft — Replay action |
| enh/15 / scanner `?ticker=` | Soft — consistent deep-link UX |
| enh/17 `/sentiment` redirect | Soft — don’t add Sentiment to nav-config if route dies |

---

## 5. Impact & Risk Analysis

- Palette must mount inside Wouter or `navigate` breaks (same lesson as the tour)
- Meta+K needs `preventDefault` to avoid browser shortcut conflicts
- `nav-config.ts` must be the single source of truth — sidebar copy edited alone would drift from the palette
- Paired with `nav-config.ts` ↔ sidebar ↔ palette ↔ tour `data-tour-id` ids — keep in sync

**Do not:** reinstall cmdk; explain-score action; new watchlist route file.

---

## Review: APPROVE — ready. cmdk already installed; extract nav-config; mount inside Wouter; `?ticker=` on watchlist.
