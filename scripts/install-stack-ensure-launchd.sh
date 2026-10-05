#!/usr/bin/env bash
# Midday stack ensure — heal API/Vite only (no enrich). Complements daily Maintain 10:30.
# Install: ./scripts/install-stack-ensure-launchd.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.fildi.stack-ensure"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

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
    <string>/opt/homebrew/bin/node</string>
    <string>${ROOT}/scripts/maintain.mjs</string>
    <string>--restart-if-unhealthy</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>45</integer></dict>
  </array>
  <key>StandardOutPath</key><string>/tmp/fildi-logs/stack-ensure-launchd.out</string>
  <key>StandardErrorPath</key><string>/tmp/fildi-logs/stack-ensure-launchd.err</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed ${LABEL} → 12:00 + 14:45 local (heal API/Vite only)"
echo "  Fri 14:45 pre-warms stack before ~12:00 PT model snapshot window."
echo "  uninstall: $0 --uninstall"
