# MCP Tools
**Working**: token-optimizer (caching, 23% reduction)
**Needs auth**: cubic (AI reviews)  
**Deprecated**: graphify (removed)

**Current config**:
```json
{"mcpServers":{"token-optimizer":{"command":"npx","args":["token-optimizer-mcp"]}}}
```

**Analysis flow**: grep_search → max 10 files → token-optimizer caching