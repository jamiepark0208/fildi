# Free / low-cost hedge-fund ops tooling (research notes)

Ideas for FILDI-adjacent workflows — not committed integrations.

## Alt-data / ownership (closest to Quiver)

| Tool | Cost | What you get | Fit for FILDI |
|---|---|---|---|
| [Quiver Quant API](https://api.quiverquant.com/) | Paid (~$30+/mo) | Congress, lobbying, contracts, 13F moves, short OTC, WSB… | Nice research tab later; not needed for gold fund pipeline |
| [Quantgress](https://github.com/DMulajkar/Quantgress) | Free self-host | Quiver-like rebuild: congress, lobbying, Form 4, 13F, short vol → DuckDB + REST | Best free Quiver alternative to prototype a “flows” tab |
| [capitol-api](https://github.com/crnicholson/capitol-api) | Free self-host | House STOCK Act trades API | Narrow congress feed |
| [congress-trading-pipeline](https://github.com/seralifatih/congress-trading-pipeline) | Free / Apify | Senate+House PTRs + lobbying from primary sources | Event feed for watchlist |

## Filings / fundamentals MCP

| Tool | Cost | Notes |
|---|---|---|
| [edgartools MCP](https://github.com/dgunning/edgartools) | Free, no key | SEC statements, Form 4, filings — good Cursor MCP for research chats |
| Our EDGAR client | Already in-repo | Keep as bronze path; MCP is for interactive agent research |

## Research / analysis platforms (free OSS)

| Tool | Use |
|---|---|
| [OpenBB](https://github.com/OpenBB-finance/OpenBB) | Broad equity/macro SDK; has MCP surfaces — research sandbox, not replace Stock DB |
| [vectorbt](https://github.com/polakowo/vectorbt) | Fast backtests / factor sweeps on your own bars |
| pandas-ta / TA-Lib | Indicators (we already own technicals pipeline) |

## HF ops workflows worth copying (product, not DB)

1. **Catalyst calendar** — earnings, filings, estimate revisions (we have pieces)
2. **Thesis review loop** — after earnings / ±20% move / peer print
3. **Positioning** — short interest, options skew, crowding (later)
4. **Filing verification** — press release claim → 10-Q/10-K check (edgartools MCP)
5. **Ownership leads** — 13F/Form 4 as idea gen, never copy blindly (45d 13F lag)

## Recommended order for FILDI

1. Keep Stock DB steady-state (weekly check) — done
2. Event-driven refresh queue (earnings first) — `.cursor/plans/event-driven-refresh.md`
3. Optional: edgartools MCP for agent research sessions
4. Optional: Quantgress or congress pipeline as a **Flows** research panel
5. Skip paid Quiver until a clear product surface needs it
