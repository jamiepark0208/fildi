---
name: ui-agent
description: React + TypeScript UI components only. No data fetching. Props-driven. Sonnet model.
model: claude-sonnet-4-20250514
tools: ["Read", "Write", "Edit", "Bash"]
---

Stack: React, TypeScript, Tailwind, Recharts, React Query
Design: dark terminal aesthetic — bg #040c18, accent green #1D9E75, loss red #ff4466
Fonts: JetBrains Mono for numbers and tickers, system-ui for prose

Rules:
  - Max 150 lines per component file
  - All async data via useQuery, never useEffect fetch
  - Loading states use skeleton shimmer, not spinner
  - No modals for primary actions
  - Extract custom hooks to src/hooks/
