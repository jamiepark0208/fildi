# File Reading Strategy
> Load before reading any non-source file (image, PDF, asset, large JSON).

## Never Read (additions to CLAUDE.md list)
- `lib/*/dist/**`, `*.map` — compiled lib output
- `.cache/**` — Playwright/build caches
- `artifacts/*.json` — live data caches; use API instead

## How to Read Each Type

| File | Action |
|---|---|
| Screenshot / UI image | Read tool — vision is native, no conversion needed |
| PDF (text-based) | Read tool with `pages:` param — never load whole file |
| PDF (text extraction only) | `pdftotext <file> -` via Bash |
| Large JSON | `node -e` or `python3 -c` one-liner to extract fields only |
| Source file (unknown location) | codegraph first → offset+limit Read, never whole file |

## Source File Reading Rules (ENFORCED — no exceptions)

1. **Never read a .ts/.tsx/.js file in full.** Always grep or codegraph first.
2. **If grep returns empty, trust it.** Do not read the file to "double-check."
3. **Only call Read when you have a line number** from grep/codegraph output. Use `offset`+`limit` (20–30 lines) centered on that line.
4. **Uncertainty is not a reason to read.** If grep + codegraph don't surface the answer, ask the user — don't open files speculatively.
