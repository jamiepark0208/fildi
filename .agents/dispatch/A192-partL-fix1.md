A192 Part L fix1 (Refs: A192). Fix findings 1–3 of "Claude review 29a95eb9" at the end of research/common/asks/A192.md exactly.
Files: artifacts/api-server/src/lib/structures/legs.ts (max loss/gain analytic at S=0 and S→∞; POP = P(S_T beyond BE) lognormal at leg IV, drift r), artifacts/api-server/src/lib/structures/rank.ts (expiry nearest horizon, ≥ horizon−7 d), legs.test.ts (+ CSP max loss = 100K − credit, short call unlimited, ATM straddle POP < 50 %, deep OTM put POP > 90 %, ranker DTE assertion).
Smoke gate: legs.test.ts green first, then re-price the 3 AAPL samples + ranker neutral 30 d $1000.
Packet (≤ 10 lines) appended to A192.md with the corrected sample numbers. Commit Refs: A192, Agent: cursor. Do not edit stocks.ts or other files with pre-existing tsc errors.
