# Corrections log
Every agent claim later found wrong (user 2026-10-15). Fewer new rows over time = the agents' reviews and memory are working.
Rows: `| date | agent | claim | correction | caught by |` — caught by = user / Muse / Cursor / self (re-check) / data (study).

| Date | Agent | Claim | Correction | Caught by |
|---|---|---|---|---|
| 10-14 | Claude | S015: puts with earnings before expiry did worse (Holm p 0.000) | 41 of 104 earnings flags were fiscal quarter ends from earnings_calendar; clean dates → p 0.21, not significant (A114) | self (POET test load) |
| 10-14 | Claude | A51 declined: "your earnings puts did better" | Ignored S003 (17k puts: earnings in window raises blow-ups); need routed to A79 + S018 | self (decline audit, after user asked) |
| 10-14 | Claude | Filed A97/A98 to Cursor | IDs already used by Muse; Muse's files overwritten. Restored; Claude rows → A113/A114 | self |
| 10-14 | Claude | optlab.bars insert safe on re-run; chain cache ok | Old-layout table breaks positional insert; cache ignored ref window (A110) | Muse |
| 10-14 | Claude | IV rank min history 60 (silent change from 120) | Undocumented change in a pre-registered study (A111) | Muse |
| 10-15 | Muse | pm_alerts crashes every run on empty DDL statement (A112) | Doesn't reproduce: psycopg accepts it; job ran ok | Claude |
| 10-15 | Muse | A97: Tgt column needs 6 parsing routes | Yahoo already sends per-firm targets for ~96 % of rows; Fildi drops them | Claude (probe) |
| 10-15 | Claude | GS Quant needs "Goldman servers" (stated loosely) | Verified: pricing calls Marquee (GsSession error); stats modules run offline | user (asked) → verified |
| 10-15 | Claude | SkillOpt trade picking: 2,500 LLM decisions/round, $5–20 | Numeric decisions need no LLM; free local rule tests instead | user |
| 10-15 | Claude | Loader would be restarted by Claude as needed | Should never need babysitting → nightly LaunchAgent + lock | user |
| 10-15 | Claude | (scoreboard) assignment odds "calibrated" | Only in backtest; per-put odds were never stored, so no live check existed. Now stored | self (scoreboard) |
| 10-15 | Claude | S020 pre-registered spread rule (worst week lower + ≥ 70 % premium per capital) | Rule ignored return: a 1-strike spread 'passed' while losing $17.5k; stricter return check added after the run, disclosed | self (sanity check) |
| 10-15 | Claude | S019 earlier claim: '343 names have 15–50 DTE Schwab puts' | Only 39 names on a single day (10-08); the rest were calls or < 15 DTE | self (re-query) |
