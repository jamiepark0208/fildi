# Cursor State
> Cursor-only — do NOT write to `.agents/context/state.md` (Claude Code).

**Last updated:** 2026-10-20

## Next build
1. A189 Panic puts high-IV signals UI (planned; data nightly already live)
2. A172 options shadow / A185 Polygon gate / A190 house view (planned)
3. Commit prior session UI (Agents Stage, crash guards, Reset Stats) when Jamie ok’s

## Phase
**ops** — A194 Schwab 1m done (needs API restart for poller). Codex on A205/A206 — no overlap.

## Shipped this session
A194: `getSchwabMinuteBars` + RTH 5m poller → `intraday_bars_1m` source=schwab; SPY smoke 265 bars.
