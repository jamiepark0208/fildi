# TradeDash — Dev Tools & Startup

## Installed dev tools (global)

| Tool | Install | Purpose |
|---|---|---|
| codegraph | `npm install -g @colbymchenry/codegraph` | Persistent code dependency graph — read index once per session instead of re-reading source files |
| markitdown-js | `npm install -g markitdown-js` | Converts PDFs, HTML, CSV, DOCX, text files to markdown. **Not useful for image OCR** (tesseract not installed) |
| madge | `npm install -g madge` | Circular dependency checker |

## codegraph usage

```bash
# First time in a repo
codegraph init        # scans + indexes (188 files, 1968 nodes, 3688 edges)

# Every session — get task context before reading any files
codegraph context "<task description>"   # returns relevant entry points + code snippets

# Other useful commands
codegraph status                         # index health + counts
codegraph query "<symbol>"              # find any symbol
codegraph callers "<fn>"                # who calls this function
codegraph callees "<fn>"                # what this function calls
codegraph impact "<symbol>"             # blast radius of a change
codegraph sync                          # re-index changed files

# MCP server (wired in .mcp.json — loads automatically)
codegraph serve --mcp
```

## markitdown-js usage

```bash
node .claude/scripts/convert.js path/to/file.pdf
node .claude/scripts/convert.js path/to/doc.html
node .claude/scripts/convert.js "path/with spaces/file.csv"   # spaces OK — args are joined
```

Script is at `.claude/scripts/convert.js`.

**Works well for:** PDF, HTML, CSV, DOCX, plain text, XML/RSS  
**Not useful for screenshots/images:** tesseract is not installed, so markitdown-js only extracts EXIF metadata from images (e.g. `ImageSize: 1097x776`), not text content.  
**For screenshots:** use Claude Code's native `Read` tool — it does multimodal vision natively, no OCR dependency needed.

## madge usage

```bash
# Check for circular deps in the frontend
madge --circular artifacts/stock-compare/src --ts-config artifacts/stock-compare/tsconfig.json
```

## Session startup sequence

1. `node .claude/scripts/rehydrate.js` — restore session state
2. `codegraph context "<first task>"` — get relevant code context without reading files
3. Check `.mcp.json` — codegraph MCP is auto-loaded by Claude Code

## .mcp.json location

`/home/runner/workspace/.mcp.json` — codegraph MCP server entry is already wired.
