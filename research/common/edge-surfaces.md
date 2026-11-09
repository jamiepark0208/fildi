# Proven edges × app surfaces (Claude 2026-11-08, Step 1 of "ship proven edges")
> Source: BOARD.md § Works × code grep of stock-compare/src + publish_model_list.py / strategy_engine.py. Re-run when a BOARD row changes.
> Shown = the rule's pick/flag reaches the surface; — = absent. "live vs claim" (A380) only on Track Record › Strategies today.

| Edge (BOARD) | Model List | Rankings | Live | Breakdown | Gap |
|---|---|---|---|---|---|
| S088/S047 top-10 puts, P(kept) ≥ 90 % | shown (sell_puts lane) | shown (Ladder tab) | — | — | Breakdown: is this name a pick today? |
| S109 rich-put lane | shown (rich_puts lane) | — | — | — | Breakdown + Live chip |
| S054 panic puts (IV30 > 48.7) | — (no chip) | — | shown (hotlist chip, put side) | — | Model List chip; Breakdown |
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
