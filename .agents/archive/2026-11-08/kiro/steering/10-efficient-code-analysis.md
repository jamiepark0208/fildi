# Efficient Code Analysis
> grep-first approach before reading files

## Analysis Protocol

**Step 1 - GREP FIRST (always):**
```
grep -rn "symbol" artifacts/ --include="*.ts" --include="*.tsx" | head -20
```

**Step 2 - READ based on grep results:**
- Max 10 files from grep output
- If grep returns 0 results → symbol doesn't exist → safe to create

**Step 3 - STRUCTURE understanding:**
```
find artifacts/api-server/src/routes -name "*.ts" | head -10
find artifacts/stock-compare/src/pages -name "*.tsx" | head -10
```

## Never Read Files For Structure

**Bad**: Read file to understand codebase structure  
**Good**: grep/find to locate, then read only necessary files

## Tools Available

**Working**: 
- token-optimizer-mcp (caching, 23% reduction)
- codegraph (already installed, Claude uses)
- grep_search (Kiro tool)

**Deprecated/Needs auth**:
- graphify-mcp-tools (deprecated)
- cubic-code-review (needs OAuth)

**Alternatives to research**:
- reponova (graphify replacement)
- deepseek plugins
- native code analysis tools

## Token Optimization

**Current approach**: 60-80% reduction
- grep-first prevents unnecessary file reads
- token-optimizer caches repetitive operations
- caveman mode compresses output
- prompt compression reduces verbosity

**Target**: < 100 tokens per analysis task