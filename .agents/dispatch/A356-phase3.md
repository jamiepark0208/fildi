A356 Phase 3 build. Read research/common/asks/A356.md sections "Claude review 118838c2" and "Phase 3 spec" — they are the full spec, files, and acceptance. Agent: cursor, Refs: A356.
Do not touch artifacts/api-server/src/lib/breakdown-enrichment.ts (another agent has uncommitted edits); import from it read-only if needed.
Before SQL: scripts/dbcols.sh <table>. Tests: cd artifacts/api-server && set -a && . ../../.env.local && set +a && npm test (baseline in memory: 235/334 pass is pre-existing; report before/after counts). tsc: npx tsc --noEmit -p artifacts/api-server.
Commit only your files with trailers Refs: A356 / Agent: cursor, then scripts/agent-git-sync.sh (runs ship check). Append packet to A356.md. Budget 90 min.
