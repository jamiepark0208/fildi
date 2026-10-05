# Schwab Market Data (Individual Trader API)

## Constraints

| Limit | Value |
|---|---|
| Non-order RPM | **120 / min / app** (we budget **100**) |
| Daily quota | **None documented** |
| Access token | ~30 minutes (auto-refresh) |
| Refresh token | **7 days** → full browser OAuth again |

## What uses Schwab (P0)

| Surface | Path | Cache | Fallback |
|---|---|---|---|
| Options chains | `getOptionsChain` → `/chains` (1 call/ticker) | route `optionsCache` **30m** + inner `schwab-options-chain` **5m** + in-flight coalesce | Yahoo |
| Live quotes | `getLivePrices` → `/quotes` ≤50, `fields=quote` | `live-price` **60s** | Yahoo |

Not on Schwab (by design for now): analyst price targets, desk news, nightly enrichment bars.

## Auth / tokens

- Env: `SCHWAB_CLIENT_ID`, `SCHWAB_SECRET` in `.env.local`
- Tokens: `~/.tradedash/schwab-tokens.json` (mode 600, never commit)
- **7-day clock** is anchored on `obtainedAt` (refresh-token issue / rotation), not access refreshes
- Initial / weekly re-auth:

```bash
node --env-file=.env.local scripts/schwab-oauth.mjs
# or paste redirect URL:
node --env-file=.env.local scripts/schwab-oauth.mjs 'https://127.0.0.1:8182/?code=...'
```

Callback must match portal: `https://127.0.0.1:8182`

## Ops

| Item | Where |
|---|---|
| Status + RPM window | `GET /api/schwab/status` → Settings → API Monitor |
| Health job | `schwab-health` every ~6h (access refresh only — **0** market RPM) |
| Cache clear | Settings cache admin includes `schwab-options-chain` |
| Live sim | `cd artifacts/api-server && node --env-file=../../.env.local --import tsx src/scripts/simulate-schwab.ts` |

## Efficiency notes

- Outer 30m options cache is the real RPM saver for scanner/UI (frontend may refetch every 5m; server still hits cache)
- Quotes omit `fundamental` (unused on live path — smaller payload)
- 401 → invalidate access + one retry; 429 → Retry-After backoff once then Yahoo
- Concurrent identical chain misses share one upstream call (`getOrCompute`)

## Other Schwab MD endpoints (not wired)

| Endpoint | Useful for | Why not P0 |
|---|---|---|
| `/quotes?fields=quote,fundamental` | pe/eps/margins/beta snapshot | We already merge Yahoo/FMP/AV/FactSet into trusted fundamentals |
| `/pricehistory` | OHLCV bars | Nightly Yahoo/FMP path already owns bars; would burn RPM |
| `/movers` | index movers | Live movers already Yahoo screener |
| `/markets` | session hours | We have local `market-hours.ts` |
| `/instruments?projection=fundamental` | instrument metadata | Overlaps fundamentals merge |
| Analyst **price targets** | — | **Not in Schwab MD API.** Use FMP tape (`fmp-analyst-feed`) + Yahoo `analystTargetPrice` + headline parser |

## Budget tips

- Scanner batch concurrency = 4
- Stay under ~100 RPM token bucket
- On hard 429/401 after retry → Yahoo automatically
