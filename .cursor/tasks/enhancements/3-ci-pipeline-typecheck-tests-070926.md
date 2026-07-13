# ci-pipeline-typecheck-tests

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P0 |
| **Area** | infra |
| **Effort** | S (~30–60 min) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [api-integration-test-harness](4-api-integration-test-harness-070926.md), [ai/7](../ai/7-agentic-verifier-gate-070926.md), [ai/9](../ai/9-agentic-commands-playbooks-070926.md) |

### Resolution (2026-07-10)
Added `.github/workflows/ci.yml`, running on push/PR: typecheck api-server → typecheck stock-compare → `pnpm test` for both packages. Both `package.json` test scripts were switched to a `'src/**/*.test.ts'` glob so new tests are auto-discovered. All 35 api-server and 268 stock-compare tests pass. Also fixed a pre-existing failing test (`rankings-helpers.test.ts`) where a winsorization edge case at n=21 wasn't being clipped correctly — updated to n=51 where the clip boundary works as intended.
