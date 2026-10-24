#!/usr/bin/env bash
# Fildi stack at login (Claude 10-24): after a Mac restart nothing started Postgres (OpenJev 07:11, maintain, freshness all
# failed) or the API/Vite (stack-ensure only 12:00/14:45). At load + every 5 min: dev-restart.sh --if-down (Postgres →
# API → Vite, only what is missing; locked, kills stale API watchers). Install: ./scripts/install-stack-up-launchd.sh   ·   uninstall: --uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.fildi.postgres"
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
    <string>/bin/bash</string>
    <string>${ROOT}/scripts/dev-restart.sh</string>
    <string>--if-down</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/tmp/fildi-logs/postgres-ensure.out</string>
  <key>StandardErrorPath</key><string>/tmp/fildi-logs/postgres-ensure.err</string>
</dict>
</plist>
PL

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed ${LABEL} → Postgres + API + Vite checked at login + every 5 min"
