#!/usr/bin/env bash
# OpenJev local (A129, Claude 10-16) — tick every 15 min + at load/wake: freeze inputs at 05:30, answer inside the
# 05:30–09:00 / 21:00–23:30 windows when the RAM guard passes (caffeinate -s only during the run), else mark missed.
# Install: ./scripts/install-openjev-launchd.sh   ·   uninstall: --uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.fildi.openjev"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed ${LABEL}"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" /tmp/fildi-logs

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${ROOT}/scripts/watchlist_sync/.venv/bin/python</string>
    <string>${ROOT}/scripts/watchlist_sync/openjev_local.py</string>
    <string>--tick</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}/scripts/watchlist_sync</string>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>/tmp/fildi-logs/openjev.out</string>
  <key>StandardErrorPath</key><string>/tmp/fildi-logs/openjev.err</string>
</dict>
</plist>
PL

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed ${LABEL} → tick every 15 min (freeze 05:30; windows 05:30–09:00, 21:00–23:30)"
