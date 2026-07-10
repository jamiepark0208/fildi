# Cursor Handoff — 2026-07-10 Session

## What was built today

### Cluster 1 — CI / Tests (enh/3 + enh/4) ✅ DONE
- Both `package.json` test scripts changed from explicit file lists to `'src/**/*.test.ts'` glob
- `api-server/tsconfig.json` — added `allowImportingTsExtensions: true` and `noEmit: true`
- `stock-compare/src/lib/rankings-helpers.test.ts:158` — z-score winsorization test fixed (n=21→51 to trigger p2/p98 clipping correctly)
- `api-server/src/lib/catalysts.test.ts` — new: 20 tests for all pure functions in `catalysts.ts` (no DB/network)
- **Result: 35/35 api-server, 268/268 stock-compare, both typechecks clean**

### Cluster 3 — Score explanations (naf/3) ✅ DONE

#### New files
- `stock-compare/src/lib/score-summary-copy.ts` — static copy per scoreType + `guideTabFor()` + `staticCopy()`
- `stock-compare/src/hooks/useScoreExplanation.ts` — shared hook; module-level `memCache` survives remounts; calls `POST /api/explain/score`
- `stock-compare/src/components/ExplainableScore.tsx` — popover wrapping any score chip; static copy always visible; "Explain more" for fund/tech only; guide deep-link
- `lib/db/drizzle/0016_explain_cache.sql` — migration for `explain_cache` table
- `lib/db/dist/schema/index.d.ts` — manually updated with `explainCache` declaration (dist is stale; composite project refs read from dist)

#### Modified files
- `lib/db/src/schema/index.ts` — added `explainCache` pgTable with composite PK (ticker, score_type)
- `api-server/src/routes/explain.ts` — cache-first: checks `explain_cache` before Haiku, upserts on miss; `scoreHash` includes `PROMPT_VERSION="v2"` so prompt changes bust cache; `max_tokens` raised 200→300
- `api-server/src/routes/explain.ts` — **prompt rewrite (v2)**: plain-English "explain to a smart non-expert" framing; 3 bullets fundamental / 2 bullets technical; picks the most significant standouts only; includes percentile vs peers; benchmark in parentheses; "what does this mean for a put seller"
- `stock-compare/src/components/rankings-leaderboard.tsx` — removed local `fetchExplanation` + useState Maps; uses `useScoreExplanation` hook; `buildFundamentalPayload` extracted
- `stock-compare/src/pages/technical.tsx` — same; `buildTechnicalPayload` + `parseBullets` extracted to module level; `TechnicalLeaderboard` uses hook
- `stock-compare/src/pages/scorecard-explanation.tsx` — reads `?tab=` from URL on mount
- `stock-compare/src/components/sidebar.tsx` — "Scorecard Guide" → "Scoring Reference"

#### Architecture decision
Score explanations go to DB (`explain_cache`) — same for all users, objective inputs. Macro/portfolio briefs stay in JSON files — personalized per watchlist.

---

## How to verify

### Run tests (should be 35/35 + 268/268, 0 failures)
```
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/stock-compare test
```

### Run typechecks (should be clean for our files)
```
pnpm --filter @workspace/api-server typecheck
pnpm --filter @workspace/stock-compare typecheck
```
Note: pre-existing implicit-any errors exist in `merge-trusted.ts`, `nightly-enrichment.ts`, `fundamentals-db.ts` etc — these are NOT from today's changes, ignore them.

### Apply DB migration
```sql
-- Run against your DATABASE_URL:
\i lib/db/drizzle/0016_explain_cache.sql
-- or: psql $DATABASE_URL -f lib/db/drizzle/0016_explain_cache.sql
```

### Manual UI test (requires ANTHROPIC_API_KEY set)
1. Open Rankings Leaderboard (home page) — PLTR (#1) and RDDT (#2) at top
2. Click **Why** on PLTR → should show spinner → 3 bullets in plain English about fundamentals
3. Click **Why** again → instant (served from `explain_cache` DB, no Haiku call)
4. Click **Why** on RDDT → similar
5. Open Technical page → Technical Rankings Leaderboard → click **Why** → 2 bullets about technical setup
6. Verify "Explain more" popover has a "Scoring Reference" link that opens `/scorecard?tab=fundamental` or `?tab=technical`
7. Sidebar should show "Scoring Reference" (was "Scorecard Guide")

### Verify explain cache is working
```sql
SELECT ticker, score_type, score_hash, LEFT(explanation, 80) as preview, generated_at
FROM explain_cache ORDER BY generated_at DESC LIMIT 10;
```

---

## What's next (for Cursor)

### ai/11 — Wire ExplainableScore into options scanner (UNBLOCKED, P0)
Hard dep naf/3 is done. Task file: `.cursor/tasks/ai/11-product-ai-explain-csp-070926.md`

Key files to read first:
- `stock-compare/src/pages/options-scanner.tsx` L123–143 (`buildReasoning`) and L573+ (expanded panel)
- `stock-compare/src/pages/technical.tsx` — `buildTechnicalPayload()` function (already extracted, reuse or import)
- `stock-compare/src/hooks/useScoreExplanation.ts` — the hook to import
- `stock-compare/src/components/ExplainableScore.tsx` — the component to wire in

What to build:
- In the scanner expanded panel (under `buildReasoning` line): add `ExplainableScore` with `scoreType="technical"` and `buildPayload` that maps the scanner row to `technicalData`
- Mirror `buildTechnicalPayload` from `technical.tsx` — the field names are the same
- Add `stopPropagation` on the Explain more button (scanner rows are clickable)
- If the row doesn't have enough data to build the full technicalData payload, show a CTA link to `/technical` instead of the "Explain more" button
- Do NOT add a new API route. Do NOT add a new local fetchExplanation. Use only the shared hook.

Run `pnpm --filter @workspace/stock-compare typecheck` after.

### naf/8 — Command palette (P2, standalone)
cmdk is already installed. Task: `.cursor/tasks/new_app_features/8-command-palette-navigation-070926.md`

### naf/5 — Scanner simple/advanced toggle (P1)
Task: `.cursor/tasks/new_app_features/5-scanner-simplified-view-070926.md`
