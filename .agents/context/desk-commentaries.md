# Desk commentaries (any labeled desk email)

## Pipeline

```
Gmail label tradedash-brief (ONLY — intentional inbox)
  → Apps Script every 15 min (per account)  [usc_v2] / [personal_v2]
  → SAME shared Drive folder "TradeDash Briefs" (.json with HTML + links)
  → Mac Drive sync → api-server ingest → normalize (category/noise/links)
  → Postgres desk_commentaries
  → Live → News: session inbox + Haiku Daily News (ad-hoc)
```

### Account banners

| Account | Executions banner | Filename segment |
|---|---|---|
| `parkjami@usc.edu` | `[usc_v2]` | `…-usc-factset-…json` |
| `jamiepark0208@gmail.com` | `[personal_v2]` | `…-personal-…json` |

If Session email is blank in Apps Script, set Script Property `ACCOUNT_TAG=usc` or `personal`.

`v2` = label-only query + HTML/outboundLinks. Paste SoT from `scripts/apps-script/SaveFactsetBriefs.gs`.

### Every scheduled run (automatic)

1. Trash `.eml` when same-stem `.json` exists
2. Prune Drive files older than **21 days**
3. Save new labeled mail as **one `.json`** (plain + html + links)

### Multi-account

1. USC + personal → same shared folder `TradeDash Briefs`
2. Filters → label `tradedash-brief` (singular)
3. Prefer filters over forwarding

## Deterministic normalize (pre-Haiku)

Server module `desk-commentary-normalize.ts`:

- Source registry (FactSet, Axios, SA, Bloomberg, ZH, TipRanks, Finimize, Daily Upside, …)
- Category: overnight / macro / politics / sector / research_note / newsletter_digest / promo / …
- Noise score (welcome/subscribe, promo pitch, tracking-link density) — exclude ≥70 from brief
- Unwrap USC urldefense / click trackers; strip EWT false tickers
- Article published-at heuristics; content link list in `meta`

## Daily News session window

- **Weekday:** calendar day America/Los_Angeles
- **Sat / Sun / Mon before 07:00 PT:** Friday 00:00 PT → now (weekend pack)

Generate uses:
1. Noise-filtered pack, **ranked by book hits + diggable activity**
2. **Secondary dig** (`desk-link-dig.ts`) — body-first analyst/PT extract; fetch content links when body is thin (TipRanks pstmrk unwrap)
3. Near earnings (book ∩ `earnings_calendar` next 14d)
4. Lean book ticker context + user feedback
5. UI: tape chips + dig cards + section cards (not a prose wall)

Soft context only — never into `fund_score`.

## Feedback loop (Live → News)

- Thumbs-down on a bullet → `not_relevant` + reason
- “Ask why it skipped…” → `ask_why`
- Stored in `desk_news_feedback`; injected into next Haiku prompt

## Verify / iterate

```bash
cd artifacts/api-server
npx tsx src/scripts/verify-desk-ingest.ts
npx tsx src/scripts/verify-desk-ingest.ts --dir="$HOME/Library/CloudStorage/.../TradeDash Briefs" --limit=40
npx tsx src/scripts/verify-desk-ingest.ts --write-goldens
pnpm test -- src/lib/desk-commentary-normalize.test.ts
```

Admin: `GET /api/desk-commentaries/parse-preview?limit=30`  
Session inbox: `GET /api/desk-commentaries/session`

## Runtime

| Piece | Who | Cadence |
|---|---|---|
| Apps Script | Google cloud | 15m |
| Drive sync | Mac | when lid open |
| Ingest + normalize | api-server scheduler | ~30m |
| Haiku Daily News | admin Generate click | ad-hoc |
| Soft context | read-only | never into `fund_score` |

## Fixtures

`artifacts/api-server/fixtures/desk-emails/` — real samples (Axios, ZH, SA, Bloomberg welcome, Finimize, FactSet, TipRanks, Daily Upside).
