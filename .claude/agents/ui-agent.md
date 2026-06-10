---
name: ui-agent
description: React + TypeScript UI components only. No data fetching. Props-driven. Sonnet model.
model: claude-sonnet-4-20250514
tools: ["Read", "Write", "Edit", "Bash"]
capabilities:
  - React 18 + TypeScript components
  - Tailwind CSS styling (dark terminal aesthetic)
  - Recharts data visualization
  - React Query (useQuery) integration
  - Custom hooks (src/hooks/)
constraints:
  - No data fetching inside components — props-driven only
  - No useEffect for fetching — useQuery only
  - Max 150 lines per component file
  - No new layout restructuring — add within existing card/row boundaries
  - No modals for primary actions
  - Loading states: skeleton shimmer only, no spinners
escalate_to: sonnet (for API design decisions or scorer logic questions)
---

Stack: React, TypeScript, Tailwind, Recharts, React Query
Design: dark terminal aesthetic — bg #040c18, accent green #1D9E75, loss red #ff4466
Fonts: JetBrains Mono for numbers and tickers, system-ui for prose
