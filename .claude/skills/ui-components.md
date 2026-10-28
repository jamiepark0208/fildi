# UI Components Skill

## Stack
- React 18, TypeScript, Tailwind CSS
- shadcn/ui primitives (Button, Card, Badge, Tooltip, Dialog) via `@/components/ui/`
- lucide-react for icons
- `cn()` from `@/lib/utils` for conditional class merging

## File conventions
- Pages: `artifacts/stock-compare/src/pages/*.tsx` — routed via React Router
- Components: `artifacts/stock-compare/src/components/*.tsx` — shared, props-driven
- No data fetching inside components — fetch in pages, pass as props

## Tables (SoT — use this, not ad-hoc cards)
Shared “ag-grid” look in `artifacts/stock-compare/src/lib/score-explain-format.tsx`:

```tsx
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";

<div className={GRID_WRAP}>
  <table className="w-full border-collapse">
    <thead><tr className={GRID_HEADER}>
      <th className={cn(GRID_TH, "text-left")}>Col</th>
    </tr></thead>
    <tbody>{rows.map((r, i) => (
      <tr key={…} className={gridRow(i)}>
        <td className={cn(GRID_TD, "text-white")}>{…}</td>
      </tr>
    ))}</tbody>
  </table>
</div>
```

- Headers: gold uppercase (`GRID_TH` already sets `text-[#d4af37]`)
- Body: `text-white` / `text-amber-50` / `text-amber-100` — **never** `text-white/40–70`, `text-muted-foreground`, or zinc grey
- Dense: no essay blurbs above tables; put help in `InfoTip` on the header
- Dates in UI: **m/d/yy** (not ISO, not “Oct 19”)

## Tab chrome (use `@/lib/sub-tabs`)
- **L1** page tabs (Live Market/Macro…, Rankings Fund/Tech/Options…) → `subTabClass(on, hue, "md")` colored
- **L2** section / scope (Live Sell Puts·Oversold, Rankings Watchlist|Overall · Sell Puts|Calls) → `guideSubTabClass` / `scopePairClass` gold
- **L3** dig / row pills → `subTabClass(on, hue, "sm")`
- Idle always white (`SUB_TAB_IDLE`) — never zinc grey

## Brand chrome
- Borders / accents: `#d4af37` gold on near-black (`bg-zinc-950` / `bg-black/40`)
- Don’t invent a second table system (rounded marketing cards, purple glow, Inter-only grey dashboards)
- **Contrast (Jamie 10-24):** never gold/amber *text* on gold/amber *fill* (same-hue). Section headers → `text-white` on `bg-zinc-800` (or similar). Status chips → white (or black) text on a solid darker fill. Accents for borders/chevrons only.

## Signal badge (GO / WATCH / NO)
```tsx
const cls = signal === "GO" ? "bg-green-500/15 text-green-400 border-green-500/30"
          : signal === "WATCH" ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
          : "bg-secondary text-amber-100 border-border";
<span className={cn("text-xs font-semibold px-2 py-0.5 rounded border", cls)}>{signal}</span>
```

## Rules
- No new layout restructuring — add features within existing card/row boundaries
- Prefer `cn()` over inline ternaries for >2 conditional classes
- Never add emojis unless user requests it
- Load this skill before restyling Agents / Rankings / Macro tables
- **Scorecard Guide / delete-blurb / move control / FAB covering data:** also load `.cursor/skills/ui-chrome/SKILL.md` (presets off, weight bar, all drivers, no grey essays)
