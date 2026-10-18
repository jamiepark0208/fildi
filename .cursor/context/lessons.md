# Cursor Lessons — mistake → guardrail
> Cursor-only. **Not** always-injected. Grep by topic before repeating a class of error.
> Max **15 active** entries; archive oldest to `lessons-archive.md` when full.

## Memory map (do not merge these stores)

| Store | Path | Who writes | Contents |
|---|---|---|---|
| Cursor lessons | `.cursor/context/lessons.md` | Cursor agents | Dev mistake → guardrail (capped 15) |
| Claude memory | `.agents/memory/*` | Claude Code | Topic tips / gotchas for Claude |
| Trader journal / P&L | product surfaces (not lessons) | App / future ai/13 | Never copy into lessons |

Before `add`: grep this file **and** skim `.agents/memory/MEMORY.md` so we don’t duplicate Claude-only tips as Cursor lessons. Archive: `lessons-archive.md` (grep tip: also check archive if active miss).

## When to add (strict — avoid noise)

Add a lesson **only if all true:**
1. User corrected a wrong assumption **or** codebase evidence disproved our claim
2. Mistake is **repeatable** (not a one-off typo)
3. Fix is a **concrete guardrail** (grep pattern, file to read, defer rule)
4. Not already covered — run `node .cursor/scripts/session-lesson-cursor.js grep "<topic>"` first

**Do not add:** preferences, style nits, one-line typos, lessons that duplicate skills/rules, trade P&L, journal tags, API keys, `.env` values, passwords.

## When to read

| Situation | Action |
|---|---|
| Proposing infra/engineering tasks | `grep -i "infra\|cache\|redis" .cursor/context/lessons.md` |
| New data source or FMP/vendor call | `grep -i "fmp\|vendor\|waterfall" .cursor/context/lessons.md` |
| PM task documentation session | `grep -i "task\|audit" .cursor/context/lessons.md` |
| sessionStart banner | Shows last 2 **Fix** lines only (via rehydrate) |

## Entry format

```markdown
### L-YYYY-MM-DD-NN: title
- **Trigger:** when to apply (one line)
- **Mistake:** what we assumed or did wrong
- **Fix:** what to do instead
- **Verify:** how to confirm (optional, one line)
- **Status:** active | deprecated YYYY-MM-DD reason
```

---

### L-2026-07-09-01: Audit infra before engineering backlog
- **Trigger:** Proposing CI, cache, queue, Redis, or "greenfield" infra tasks
- **Mistake:** Assumed no CI, no persistence, no job orchestration — missed TTLCache registry, PG fundamentals/technicals, startup `withRetry` in `index.ts`
- **Fix:** Grep `cache-registry.ts`, `fundamentals-db.ts`, `index.ts` startup; add § Audit with "already exists" before marking task ready
- **Verify:** Task cites existing files or marks P3 defer with reason
- **Status:** active

### L-2026-07-09-02: Verify vendor tier before assuming API fields
- **Trigger:** Adding or recommending paid vendor endpoints (FMP, Finnhub estimates, etc.)
- **Mistake:** Assumed FMP `/stable/price-target` returns per-bank PTs on free tier; user verified consensus-only
- **Fix:** Empirical test on 1 ticker + user tier; document in task; remove dead calls from hot paths
- **Verify:** `logApiCall` or manual curl shows non-empty body on user's plan
- **Status:** active

### L-2026-07-09-03: Plan execution scope = task docs unless asked
- **Trigger:** User says "implement the plan" after a PM/audit planning session
- **Mistake:** Risk of writing application code when plan Part D says task markdown only
- **Fix:** Write/update `.cursor/tasks/*.md`, INDEX, cursor-state — **no** api-server/stock-compare changes unless user explicitly requests build
- **Verify:** `git diff` shows only `.cursor/` paths
- **Status:** active

### L-2026-07-09-04: data-agent waterfall before new data tasks
- **Trigger:** New fetch, cache layer, or backfill task
- **Mistake:** Suggested Redis/pg-boss/precomputed rankings without checking data-agent.md Tier A/B/C and existing PG persistence
- **Fix:** Read `.claude/skills/data-agent.md` + `caching-patterns.md`; cheapest source first; max 3 concurrent; defer Redis (no Redis in prod)
- **Verify:** Task lists data tier, source order, and `check*Budget` if paid API
- **Status:** active

### L-2026-07-09-05: Single source for catalyst/analyst formatting
- **Trigger:** Touching catalysts, breakdown analyst actions, or rating history UI
- **Mistake:** `buildCatalysts` duplicated in API (`catalysts.ts`) and frontend (`catalysts-section.tsx`)
- **Fix:** Server computes `catalysts[]`; UI consumes breakdown payload only; delete frontend duplicate when touching this area
- **Verify:** One `buildCatalysts` definition in api-server
- **Status:** active

### L-2026-09-28-01: Quote Stock DB coverage as filled/total like the UI
- **Trigger:** Reporting fundamentals coverage, null rates, or Stock DB quality
- **Mistake:** Quoted PEG/PE null counts (~321 null) while UI shows filled/total (234/558); looked like disagreement
- **Fix:** Always report filled/total matching StockDBTab colCoverage (non-null gold / universe). Say nulls separately. Refresh UI after merge before comparing.
- **Verify:** psql: COUNT(peg_ratio) FROM ticker_fundamentals should ≈ UI PEG filled
- **Status:** active

### L-2026-09-29-01: PEG coverage needs growth; P/B does not
- **Trigger:** User asks why PE/PEG coverage << P/B or P/S
- **Mistake:** Treated null PEG like a fetch bug; P/B fills for unprofitable names
- **Fix:** PE needs EPS>0; PEG needs usable growth (trailing or forwardEps fallback, 1%–500%). Never invent PE for losses. Stock DB API uses fetch_fundamentals universe only.
- **Verify:** COUNT(peg_ratio) after merge; pe_null all have eps<=0
- **Status:** active

### L-2026-09-29-02: FactSet must dual-write api_usage for API Monitor
- **Trigger:** FactSet fetch, referee, or API Monitor missing FactSet
- **Mistake:** Only bumped data_sources.calls_today; Monitor reads api_usage — FactSet invisible
- **Fix:** incrementFactsetCalls → recordApiUsage('factset'); ApiMonitor PRIMARY_SOURCES includes factset (500/day)
- **Verify:** SELECT calls_made FROM api_usage WHERE source='factset' AND date=CURRENT_DATE
- **Status:** active

### L-2026-09-29-03: API usage dates must be US/Pacific not UTC ISO
- **Trigger:** API Monitor Today/Yesterday wrong; recordApiUsage; buildDateLabels
- **Mistake:** Used toISOString().slice(0,10) — after 5pm PT that is tomorrow UTC
- **Fix:** usageCalendarDate() America/Los_Angeles; UI localIsoDate(); never UTC for daily budgets
- **Verify:** At evening PT, Monitor Today matches api_usage date = CURRENT_DATE
- **Status:** active

### L-2026-10-09-01: Daily News density: one strip, no grey-on-grey, tooltips not columns
- **Trigger:** Daily News UI / Live news styling / densify briefing panel
- **Mistake:** Shipped two banners (session + LIVE), grey meta (session 2026-10-09, AM BRIEF, 22 in/22), same-hue filled boxes with same-color text, duplicate Muse paraphrase sections, earnings split by source, and inbox IN/N columns that were always green/0 — user had to re-ask the same density rules every session.
- **Fix:** Header = Daily News · m/d/yy only (white meta). One LIVE strip (Muse levels + Yahoo 1d % labeled). Cards: orange border (#d4af37) + zinc-950 fill, never tinted fill matching text. Sources/folder/verdict = title tooltips on bullets/tickers, not grey columns. Merge earnings by date (book gold / major violet). Haiku = Desk adds only (never paraphrase Muse). Inbox: drop IN/N; compact WHEN m/d h:mma; small nl tags.
- **Verify:** No sessionLabel/AM BRIEF/in-total in header; single Live strip; hover dig/bullet shows source; inbox table has Cat/Source/When/Subject only.
- **Status:** active

### L-2026-10-14-01: Status strips: one line, Radix tooltips, no side metrics
- **Trigger:** API Monitor / Connections / Settings status chips / dense UI strips
- **Mistake:** Put metrics next to dots (40, fb, 195h), used native title= under overflow-hidden, and flex-wrap/gaps that shoved Re-auth to a second row — user re-asked every session.
- **Fix:** Dot+short label under; metrics in Radix Tooltip portal; flex-nowrap gap-x-1; see .cursor/rules/ui-density.mdc
- **Verify:** Connections stays one row with Re-auth; hover chip shows tip bubble
- **Status:** active

### L-2026-10-18-01: Typecheck before push — bad import kills whole API
- **Trigger:** Any commit under `artifacts/api-server/src/**` or `artifacts/stock-compare/src/**`; urge to "just sync" after ASKS ship
- **Mistake:** A94 used `middleware/auth.js` (does not exist; real file is `requireAdmin.js`). Skipped local `tsc`. Server crash-looped → Vite proxy ECONNREFUSED → app fully broken; every later push emailed CI failure
- **Fix:** Run `scripts/agent-ship-check.sh` before commit; `agent-git-sync.sh` + pre-push enforce it. Copy import paths from a sibling route. No sleep-loops / subagent fan-out to ship Ready rows
- **Verify:** `pnpm exec tsc -p artifacts/api-server/tsconfig.json --noEmit` green; `curl -sf :8080/api/healthz` when Mac stack should be live
- **Status:** active
