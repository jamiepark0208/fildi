#!/usr/bin/env bash
# A209 P3 — one-liner learn ritual for any adapter (Claude/Cursor/Codex/Muse).
# Usage: scripts/agent-learn.sh [agent]
# Prints top waste turns from GET /api/agents/learn (local API).
set -euo pipefail
AGENT="${1:-}"
URL="http://127.0.0.1:8080/api/agents/learn"
if [[ -n "$AGENT" ]]; then URL="${URL}?agent=${AGENT}"; fi
if ! curl -sf "$URL" >/tmp/fildi-learn.json 2>/dev/null; then
  echo "learn: API down or unauthorized — skip (start local stack)"
  exit 0
fi
python3 - <<'PY'
import json
from pathlib import Path
d = json.loads(Path("/tmp/fildi-learn.json").read_text())
waste = d.get("wasteTop") or []
roll = d.get("rollups24h") or []
print("learn rollups24h:", ", ".join(f"{r.get('agent')} n={r.get('n')} loop={r.get('loop_pct')}% fail={r.get('fail_pct')}%" for r in roll[:6]) or "(none)")
print("waste top:")
if not waste:
  print("  (empty)")
else:
  for t in waste[:3]:
    print(f"  {t.get('agent')} tools={t.get('tools')} out={t.get('out_tok')} loop={t.get('loop_hits')} {t.get('ask_id') or '—'} {t.get('outcome') or ''}")
print("prefer: oj.py / codegraph when Acts/cmt or loop high")
PY
