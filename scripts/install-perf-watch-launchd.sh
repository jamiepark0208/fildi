#!/bin/bash
# perf-watch every 30 min → ~/.fildi/perf-watch.{json,md}; agent_start step 5c shows it to every agent (10-28).
# Read-only (API log + pmset + localhost healthz). No alerts to Jamie (10-14 rule: no push/email).
#
#   ./scripts/install-perf-watch-launchd.sh
#   ./scripts/install-perf-watch-launchd.sh --uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.fildi.perf-watch"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE=""
for candidate in /opt/homebrew/bin/node "$HOME/.local/bin/node" /usr/local/bin/node; do
  if [[ -x "$candidate" ]]; then NODE="$candidate"; break; fi
done
if [[ -z "$NODE" ]]; then NODE="$(command -v node || true)"; fi
if [[ -z "$NODE" ]]; then echo "ERROR: node not found" >&2; exit 1; fi

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed ${LABEL}"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" /tmp/fildi-logs
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${ROOT}/scripts/perf-watch.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>StartInterval</key><integer>1800</integer>
  <key>StandardOutPath</key><string>/tmp/fildi-logs/perf-watch-launchd.out</string>
  <key>StandardErrorPath</key><string>/tmp/fildi-logs/perf-watch-launchd.err</string>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
echo "Installed ${LABEL} → every 30 min (output ~/.fildi/perf-watch.md)"
