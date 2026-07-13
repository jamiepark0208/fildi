# api-dev-hot-reload

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P1 |
| **Area** | infra |
| **Effort** | S (~30–60 min) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | `.claude/skills/build-and-run.md` |

### Resolution (2026-07-11)
Implemented as part of enh/34 Wave D, same scope. `tsx watch` was added as `dev:watch` (aliased from `dev`) so backend edits are reflected in ~3s without a manual esbuild rebuild; the old rebuild flow is preserved as `dev:rebuild`. Production `build`/`start` (esbuild → `dist/index.mjs`) is untouched. `build-and-run.md` was updated to document the watch command instead of claiming hot-reload is impossible.
