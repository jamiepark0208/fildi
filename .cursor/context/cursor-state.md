# Cursor State
> Cursor-only — do NOT write to `.agents/context/state.md` (Claude Code).

**Last updated:** 2026-10-26 (Live chart "Value is null" fixed)

## Standing
- **A241 GCP public shadow: STOPPED.** Do not resume, recon, provision, or cut over unless Jamie explicitly unparks.
- No auto-chain on parked/stopped infra rows.

## Live
- A241 closed 10-26: VM `fildi-public-1` **TERMINATED**; `fildi-public-tick.timer` disabled earlier; no claim file.
- Mac unchanged (`FILDI_HOST_ROLE` unset). Public Fildi for other users = **new ask later**, not A241.
- **Live session chart (10-26):** gainer/loser rapid clicks crashed RouteErrorBoundary (`Value is null` = LWC `setVisibleRange`/`timeToIndex`). Fixed: logical range + try/catch + ChartIsolate; movers/hotlist → chart wired. Soft gaps: `/api/live/market-context` + regime outlook API libs exist untracked — strip/outlook degrade to empty until routed.
- **UI crash bus (10-26):** browser → `POST /api/client/ui-crash` → `~/.fildi/ui-crashes.jsonl`; agent_start step 12 + Cursor rehydrate banner. Also hardened Breakdown/Home `price-chart` LWC swaps. Act on step 12 without waiting for Jamie.

## Next (auto)
1. Normal Muse→Cursor planned queue only (not A241)
2. Ignore GCP / parity / public-tick unless Jamie unparks A241
