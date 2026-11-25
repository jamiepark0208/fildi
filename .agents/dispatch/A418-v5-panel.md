Build ASKS row A418 exactly as specified in research/common/asks/A418.md (read it first; status planned).
Files: artifacts/stock-compare/src/components/options-structures/structure-picks.tsx (add a click on the ticker cell that opens the panel) + NEW artifacts/stock-compare/src/components/options-structures/idea-structures-panel.tsx.
API already exists: GET /api/options/structures/idea/:ticker (artifacts/api-server/src/lib/option-score-snapshots.ts readIdeaStructures). Payload contract: the "Claude V3 2026-11-24" paragraph near the end of research/common/asks/A192.md. Do NOT edit api-server.
Follow existing fetch pattern in structure-picks.tsx (react-query; staleTime >= 10 min; no polling). No client-side math on scores.
structure-picks.tsx may have another agent's uncommitted hunks: build on them, commit only your hunks/paths.
Acceptance: scripts/agent-ship-check.sh passes for stock-compare typecheck; NVDA panel = 16 rows incl. 3 baselines; unknown ticker → "no structure comparison today".
Commit with trailers "Refs: A418" and "Agent: cursor", sync with scripts/agent-git-sync.sh, set A418 status done in research/common/ASKS.md and asks/A418.md.
