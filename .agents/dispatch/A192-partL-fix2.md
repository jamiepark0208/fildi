A192 Part L fix2 (Refs: A192). Fix findings 1–2 of "Claude review 6aeccb50" at the end of research/common/asks/A192.md.
Files: artifacts/api-server/src/lib/structures/legs.ts (POP T = leg expiry / front expiry), rank.ts (expiry fallback with both sides + note; expose chain coverage), legs.test.ts (POP 4 DTE > 30 DTE OTM short put; ranker fallback returns rows on AAPL), StructureRanker.tsx (show the fallback note).
Smoke gate: tests green first; then re-price the 3 AAPL samples and the ranker neutral 30 d $1000.
Packet ≤ 8 lines appended to A192.md. Commit Refs: A192, Agent: cursor. Do not edit files with pre-existing tsc errors.
