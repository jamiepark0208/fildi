# Proven edges × app surfaces (Claude 2026-11-08, Step 1 of "ship proven edges")
> Source: BOARD.md § Works × code grep of stock-compare/src + publish_model_list.py / strategy_engine.py. Re-run when a BOARD row changes.
> Shown = the rule's pick/flag reaches the surface; — = absent. "live vs claim" (A380) only on Track Record › Strategies today.

| Edge (BOARD) | Model List | Rankings | Live | Breakdown | Gap |
|---|---|---|---|---|---|
| S088/S047 top-10 puts, P(kept) ≥ 90 % | shown (sell_puts lane) | shown (Ladder tab) | — | — | Breakdown: is this name a pick today? |
| S109 rich-put lane | shown (rich_puts lane) | — | — | — | Breakdown + Live chip |
| S054 panic puts (IV30 > 48.7) | shown (panic chip, sell_puts + rich_puts, 11-09) | — | shown (hotlist chip, put side) | — | Model List chip; Breakdown |
| S101 sharp-drop → higher put Δ | shown (engine strike band, in why text) | shown (Rules tab) | — | — | Breakdown band line |
| S100 revisions + 60d calls | — (no long-call lane) | shown (Structures › Long options) | — | — | Breakdown; claim not yet vs ±25 % cost (A244 parked) |
| S046 calls, options-1.2.0 | in option score | Options tab (score) | — | — | ok as a score input |
| S003/S004 IV÷RV | in fit score | Rules | — | shown (memo header) | ok |
| S028 credit spreads warning | display | — | shown (portfolio alerts) | — | ok (market-level) |
| S159 index oversold | — | — | trigger chip | — | underpowered label; ok |
| S171 momentum ∧ cheap-vol calls | — | — | — | — | paper board not built (A244 spec, Cursor) |

## Biggest gap → Step 2
**Breakdown shows no rule at all.** Opening a stock never tells you "today this name is a top-10 put / rich-lane put / panic put / long-call board pick, at strike K, rule's live record n / hit". Every number already sits in 3 tables — no new research, no new fetch:
- `watchlist_sync.put_recs_daily` (latest as_of, ticker; payload = pick, `rich`, engine band + why)
- `watchlist_sync.strategy_signals` (status open, last 3 d; panic-puts-hiv etc., trigger text, strike/expiry/entry_mid)
- `watchlist_sync.long_option_board` (latest as_of; payload rows for the ticker)

**Spec:** `GET /api/stocks/:ticker/edges` → `[{rule, study, side, strike, expiry, premium, why, live: {n, hit, vs_claim}}]` read-only, DB only, one query per table, 5-min TTL via lib/ttl-cache.ts. Breakdown header strip "Rules firing today" (one chip per row, method + study in tooltip; empty state "no proven rule fires on <T> today"). Live record per rule from the same source Track Record › Strategies uses (A380), never a re-computed number.
**Pass:** for 3 names (one Model List put pick, one rich-lane, one with none) the strip matches the Model List / Rankings rows for the same day exactly; Playwright screenshot; ship-check green.
**Then:** S054 chip on Model List; S109 chip on Live.

## Step 2 DONE (Claude 11-08 late)
Breakdown header "Rules today" strip shipped: `GET /api/stocks/:t/edges` (routes/stock-edges.ts, 5-min TTL) reads model_items latest run (sell_puts / rich_puts / sell_calls = the Model List rows), put_recs_daily engine decision (why not a pick), put_ladder P(kept) ≥ 90 % (S088), Strategy Library open signals (library ids only; unproven paper ids dropped) with live graded n, long-options board collapsed to one row per side. Each chip's tooltip says backtest vs live. Verified Playwright 11-08: LCID rich #1 P2.50 11/20 @0.19 blocked (panic) = Model List row; INTC rich #57 + ladder 1w + long boards; ADI panic-puts signal; KO empty state. No Model List put pick exists today (11-06 panic gate → 0 pass), so that chip type is untested live.
Gaps left: live record per rule still n 0 everywhere (A380 not built); panic-puts signal has no priced contract until the pricer runs. Next: S054 chip on Model List, S109 chip on Live.

**11-09:** S054 'panic' chip on Model List put rows (model-list-panel.tsx, reuses useActivePanicPutBadges = Live hotlist source; tooltip = trigger, signal contract, backtest, live n). Playwright: 81 chips on rich_puts = DB count 81/151. Conflict open: band_engine market panic (VIX÷VIX3M ≥ 1) blocks all new puts while S054 fires on 176 names → Model List banner 'ANOMALY'. Next: S109 chip on Live.
