# Feed redesign — Instagram/LinkedIn-style social feed (rescoped enh13)

## Context

enh13 as filed only asked for small polish (show n on TopPerformers, make notes prominent, add a scanner CTA) and explicitly said "do not rebuild." That's not what's needed. The actual ask: the Feed page (opened via the FILDI home icon) should read as a real social feed — remove the All/Open/Wins/Losses/Closed status pills entirely, keep the Recent/Top toggle (fixing a live bug where switching it eventually shows stale/wrong results), and give the whole page a legitimate social-app visual language instead of a data-table look. enh14 (profile) and enh21 (settings) are unrelated pages and are out of scope for this pass — left as-is in the ready queue.

## Root cause of the Recent/Top bug

`feed.tsx` (pages/feed.tsx:229-244) manually paginates by calling `setAllPosts(posts)` / `setOffset(0)` **inside** the `queryFn` as a side effect, then separately tracks `offset`/`hasMore` in local state (`loadMore`, lines 280-289). React Query does not guarantee in-order resolution — if you flip Recent→Top→Recent quickly, an older in-flight request can resolve after a newer one and its `setAllPosts` call clobbers the current (correct) results with stale data. This is the "eventually breaks" bug.

Fix: replace the hand-rolled offset/setState pagination with `useInfiniteQuery` (already available from `@tanstack/react-query`, same package already imported). Query key becomes `["feed","posts", ticker, username, sort]`; `pageParam` = offset; `getNextPageParam` returns the next offset when a page is full, else `undefined`. React Query owns cancellation/staleness per key, so there's no more manual state to desync. Pages are flattened via `useMemo` for rendering. This removes the bug class rather than patching a symptom.

## Scope

**Remove:** `StatusFilter` type, `STATUS_MAP`, `STATUS_PILLS`, the status pill button row, and the `status` query param from the frontend request (feed.tsx:187-196, 217, 222, 291-297, 342-355). No backend change needed — `status` is already an optional filter server-side (`routes/feed.ts:88`), so simply not sending it is safe and reversible.

**Keep, fix:** search box (ticker/@username), Recent/Top toggle — rebuilt on `useInfiniteQuery`, sticky TopPerformers sidebar (visual polish only, same data logic).

**Visual redesign (both files):**
- `TradeCard.tsx`: promote the user identity row to a real post header (bigger avatar, bold clickable username + timestamp as a byline, like a LinkedIn/Instagram post header) instead of a small badge crammed next to ticker/status chips. Move ticker/status/signal badges to a secondary line under the header. Give `notes` a clear "Thesis" label treatment instead of plain italic muted text. Turn the like/comment row into a full-width action bar (icon + count, more breathing room) — same handlers, no behavior change. Add a small "Validate in scanner" text-link CTA in the action row that navigates to `/options-scanner?ticker=...` (carried over from original enh13 — cheap, fits naturally as a feed CTA).
- `feed.tsx`: TopPerformers gets the `n={resolved}` count shown next to win rate (carried from original enh13), greyed styling when `n < 5`. Restyle the top bar / search / sort toggle row now that status pills are gone — sort toggle becomes the primary filter control, styled as a segmented pill. Tighten card list spacing to read as a feed, not a data table.

**Explicitly not doing:** new API routes, TipRanks import, Redis, rebuilding comment/like/close CRUD, touching enh14 (profile) or enh21 (settings).

## Files to modify

| File | Change |
|---|---|
| `artifacts/stock-compare/src/pages/feed.tsx` | Remove status filter state/UI/param; replace manual offset pagination with `useInfiniteQuery`; TopPerformers n display; header/toolbar restyle |
| `artifacts/stock-compare/src/components/TradeCard.tsx` | Post-header redesign (avatar/username/timestamp), thesis-styled notes, full-width action bar, scanner CTA link |
| `.cursor/tasks/enhancements/13-feed-improvements-070926.md` | Rewrite Purpose/scope to match this rescoped plan; status stays `ready` → will flip to `done` after shipping (session-wrap convention) |

No changes to `routes/feed.ts`, no new DB/API surface.

## Verification

- `cd artifacts/stock-compare && npx tsc --noEmit` (typecheck, per repo convention)
- Playwright is unavailable this session per hook status, so no automated `/verify` — rebuild + restart api-server/stock-compare per `.claude/skills/build-and-run.md`, then hand back to user to visually confirm in Preview (matches this session's established pattern for UI work)
- Manually reason through the race fix: confirm `useInfiniteQuery`'s query key changes on sort/search change (old query auto-cancelled) and that flipping Recent→Top→Recent rapidly no longer needs manual offset bookkeeping
