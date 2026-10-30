---
name: fildi-briefs-dig
description: Dig deeper into Jamie's tradedash-brief newsletters (desk_commentaries) — turn each email into typed facts and claims, resolve them against Fildi data, test the ones that matter for the book, and grade sources over time. Use for Live commentary, earnings reads, market theses, and any "what did the briefs say / what does it mean" task.
---

# Briefs dig (Jamie 10-30)

Jamie routes ~20 emails/day (Gmail label `tradedash-brief` → Drive → `desk_commentaries`) so agents get good data. Summarising them is
the floor. The value is the **dig**: take what an email asserts, check it against our data, work out what it means for the book and
the Model List, and remember whether that source was right.

Plan + build order: `research/common/briefs-dig-plan-2026-10-30.md`. Ingest: `.agents/context/desk-commentaries.md`.

## 0. Before you read anything
- **One reader.** Facts come from the shared extractor (plan stage 1, `desk_facts`), never a new per-feature parser (B19). Until it
  exists, reuse `lib/desk-link-dig.ts` / `desk-dig-enrich.ts` (analyst teasers) and `earnings_packet.briefs_for` (per-ticker lines).
- **Full text.** `body_plain` was cut at 12,000 chars (47 % of emails, 10-30); the Drive JSON (`bodyHtml`, `outboundLinks`) is whole but
  pruned at 21 days. Read the full body when a fact sits past the cut.
- **Muse first** on Live commentary, then add what the briefs add (desk-daily-news.ts, A301).

## 1. Source tiers (judge the source before the claim)
| Tier | Sources | Use |
|---|---|---|
| A — reported facts | FactSet StreetAccount (recaps, sector post-market, bullish/bearish talking points, week ahead, morning watchlist), LSEG Morning News Call / Day Ahead, Bloomberg news items | numbers vs consensus, segment / guide, events, calendar — still verify numbers that drive a decision |
| B — reported + framing | Bloomberg newsletters (Five Things, Tech In Depth, Money Stuff), WSJ 10-Point / Markets A.M., Daily Upside, Rundown AI | facts usable; the framing ("AI reckoning", "boring stocks are beautiful") is a **claim** to test |
| C — pointers | TipRanks watchlist teasers ("13 new analyst ratings"), GuruFocus market today | never the fact itself — resolve to our tables (analyst_events, packets) |
| D — vendor signals / promo | Danelfin AI score, TipRanks "Strong Buy" lists, sponsored, ZeroHedge headlines, welcome / webinar mail | log as a forecast and grade it; never act on it ungraded |
Source tiers are a prior. The grade history (stage 5) replaces it per sender once ≥ 30 claims are graded.

## 2. What to dig (the 11 kinds) — and the move for each
| Kind | Example (10-26..30) | Dig move → Fildi data |
|---|---|---|
| analyst action | TipRanks: GOOGL 13 new ratings, GEV 5, PLTR 3; GS favours SNDK over INTC | `analyst_events` since the print: up/down count, median PT change (new vs prior), PT dispersion vs price, initiations; our PT-revision evidence (fair-value memory: revisions predict, cheapness gaps don't); book/put exposure |
| earnings detail | "Search +12 % vs +15 % cons", "AWS +39 %, backlog $578 B", NOW −27 % on cRPO | `earnings_packets` (8-K bridge) + transcript; segment vs consensus; peer read-through to names on the put list (NOW → software, INTC → PC/memory) |
| guidance / calendar | week ahead: PLTR AMD ARM ON AAPL report; ISM, jobs; Anthropic IPO ~11-20 | diff vs `earnings_calendar` (B17 evidence), puts crossing the date, macro calendar |
| macro number | CPI 3.7 % y/y, GDP 3.4 %, "76 % chance of a Dec hike" | FRED / macro_daily / Kalshi — agree or flag; house view + themes signposts |
| market-structure claim | "equal-weight beat cap-weight by > 150 bp Thursday", "Nasdaq 100 −3 %" | prices_historical / RSP vs SPY — verify the number, then the reading (rotation vs risk-off: S148) |
| cross-company theme | input-cost inflation (SW, F, LII, SHW, LOGI, KO); K-shaped consumer (UPS, V, HSY); AI funding (MSFT $25 B debt, META ~$100 B raise, AVGO $63 B SPV, ORCL FCF path) | count independent mentions across sources/days; map to `themes.json` signposts (ai_credit, spender_fcf, inflation); test with packet data (margins, capex, FCF across reporters) |
| corporate event | MRVL–LITE talks, DASH–CART $17 B, EQT–RRC, GEV Trench $9 B + $20 B buyback, SK Hynix $75 B return | book / put-candidate exposure (all of these were in 10-30 put_recs candidates); M&A gate on puts; stock_notes |
| geopolitics | "US told Gulf states to prepare for a short, intense Iran campaign after the midterms" | geo theme (GPR, oil), scenario on put risk; date-stamp the claim and grade it |
| shock / risk event | Binance $6.3 B hack | exposure (COIN, HOOD, MSTR on the put list), Live risk, follow-ups |
| opinion / judgement | "AAPL looks risky ahead of Q4", "AI bubble", Money Stuff essays | rewrite as a testable claim (what would be true if right?) → our data/studies → verdict right / wrong / untested + what it means; log for grading |
| vendor signal | Danelfin daily AI score top list | forecast ledger: log picks, grade at the stated horizon (3 m) vs SPY before any use |

## 3. How to dig one item (every dig, every model)
1. **Claim** — one sentence, source, date, tickers, the number(s) quoted.
2. **Our data** — the table/study that tests it; quote our number next to theirs. Disagree → say so, show both.
3. **So what** — which book position / put candidate / Model List name / theme signpost moves, and how (memory so-what).
4. **Verdict** — confirmed · contradicted · partly (why) · untested (what data would test it). Opinions get a test, not a summary.
5. **Follow-up** — the event that settles it (date) → logged to the claims ledger for grading.
Numbers in the output must trace to the email or our tables (same checker as earnings_notes.numbers_ok). Never invent a mechanism.

## 4. Prioritise (≤ 10 Sonnet digs/day)
Score = exposure (held > published put > put candidate > Model List > universe) × materiality (|move|, $ size, gap vs consensus)
× novelty (not already in a note/fact) × source tier. Repeated across ≥ 2 independent sources → +1 tier. Dig the top 10; the rest
stay as facts.

## 5. Models
- **Haiku** — extraction only: email → typed facts JSON (cheap, every email). Not for judgement.
- **Sonnet** — the dig (stage 3): reading facts + our data → memo. Numbers checked by code.
- **Opus** — weekly synthesis: the week's facts + StreetAccount bullish/bearish points → THESIS update (fildi-market-thesis).
- No LLM computes or compares numbers; code does, the model explains.

## 6. Grade
Every checkable claim and vendor signal goes to the claims ledger with a horizon; graded automatically. Per-source hit rate →
replaces the hand-set tier and the ingest `noise_score`. A source that is wrong more than it is right on graded claims drops a tier.
