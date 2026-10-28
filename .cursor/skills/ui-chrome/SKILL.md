---
name: ui-chrome
description: >-
  Fildi app chrome trim — Scorecard Guide, Settings strips, FABs, blurbs, presets.
  Use when Jamie deletes/moves UI, says too much text, compact, blocking widget,
  Scorecard Fund/Tech/Options walkthrough, or Feedback overlays data.
  NOT for greenfield marketing pages (use frontend-design). NOT for table GRID_* only (ui-components).
---

# UI chrome (TradeDash) — always apply these when touching app chrome

Jamie repeats the same asks because agents skip this. **Load this skill before editing** Scorecard Guide, Settings Conn strip, FeedbackWidget, walkthrough headers, or any “delete this blurb / move control / match Fund”.

## Non‑negotiables

0. **Ideas (Agents):** title = `Ideas (N)` only — no “by stage · shown”. No “this wave” badge, Clear highlights, Show debt, or Show done/parked. Debt = amber dashed ring on the cube. Detail card = gold hairline + phase pill + title; no duplicate Assigned/route lines; dates **m/d/yy**.
1. **No Presets** on Scorecard Fund/Tech/Options header. Ticker search = `ml-auto` inline with tabs.
2. **Weighted surfaces** get a horizontal **color weight bar** (Fund `FamilyWeightBar` / Tech `ComponentWeightBar`).
3. Cards show **all drivers**, not top‑2. Label **Drivers**.
4. **No grey essay blurbs** under grids (“Components are self-relative…”). Help → hover/`DataTip` only.
5. Failed-study / display-only metrics = **Context (not in total)** with study id in tip — never fake weight.
6. TV indicators (UT/ST/SMC/F&G) ≠ tech total (S102) — context only.
7. **Don’t cover data** with FABs — Feedback is draggable/minimizable; default away from ticker column.
8. Brand: gold `#d4af37` on near-black; body text **white**, not muted grey (`ui-components.md`).
9. Dates **m/d/yy**. Dense strips: `ui-density.mdc` (dot+label; metrics in Radix Tooltip).
10. **Small diffs** — one chrome concern per edit. No drive-by restyle of the page.

## Anti-patterns (do not)

- Cursor Automation / scheduled job that “cleans UI”
- Batch deleting copy without checklist
- Adding presets back “for admin convenience” on the walkthrough header
- Purple glow / Inter-grey dashboards / marketing cards on data pages

## Related

- Tables: `.claude/skills/ui-components.md`
- Density chips: `.cursor/rules/ui-density.mdc`
- Map: `.cursor/context/prompt-automation-map.md` (§ UI trim = skill only)
