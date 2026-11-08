A192 Part C fix3 (Refs: A192). Fix "Claude review 7e4a142b" at the end of research/common/asks/A192.md (OTM constraint on the credit search).
Files: artifacts/api-server/src/lib/structures/templates.ts (the 8 credit-search templates), legs.test.ts (Δ box + credit-size asserts for the 8).
Smoke gate: new asserts fail on 7e4a142b first, then pass; print TEMPLATE lines for the 8.
Packet ≤ 6 lines appended to A192.md. Commit Refs: A192, Agent: cursor.
