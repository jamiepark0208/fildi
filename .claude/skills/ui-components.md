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

## Patterns used in this project

### Card container
```tsx
<div className="bg-card border border-border rounded-xl p-6 shadow-sm">
```

### Muted label / reason text
```tsx
<div className="text-xs text-muted-foreground/70 italic">{text}</div>
```

### Signal badge (GO / WATCH / NO)
```tsx
const cls = signal === "GO" ? "bg-green-500/15 text-green-400 border-green-500/30"
          : signal === "WATCH" ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
          : "bg-secondary text-muted-foreground border-border";
<span className={cn("text-xs font-semibold px-2 py-0.5 rounded border", cls)}>{signal}</span>
```

### Ghost action button (unobtrusive inline)
```tsx
<button className="text-xs text-muted-foreground hover:text-foreground transition-colors">
  Label
</button>
```

### Inline explanation block (analyst-comment style)
```tsx
<div className="mt-1.5 pl-3 border-l-2 border-border text-xs text-muted-foreground/80 italic leading-relaxed">
  {explanation}
</div>
```

### Loading spinner (inline, small)
```tsx
<span className="text-xs text-muted-foreground animate-pulse">Generating…</span>
```

## Rules
- No new layout restructuring — add features within existing card/row boundaries
- Default to `text-xs` for secondary content, `text-sm` for primary body
- Use `max-w-[Xpx]` truncation on long text in leaderboard rows to prevent overflow
- Never add emojis unless user requests it
- Prefer `cn()` over inline ternaries for >2 conditional classes
