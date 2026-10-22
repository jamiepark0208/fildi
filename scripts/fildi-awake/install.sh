#!/bin/bash
# One-time install (Jamie runs with sudo). Copies fildi-awake root-owned and adds a sudoers rule for that one file only.
#   sudo bash scripts/fildi-awake/install.sh          install
#   sudo bash scripts/fildi-awake/install.sh --remove uninstall (also turns sleep back to normal)
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
DST=/usr/local/sbin/fildi-awake
RULE=/etc/sudoers.d/fildi-awake
USER_NAME="${SUDO_USER:?run via sudo from your account}"

if [[ "${1:-}" == "--remove" ]]; then
  [[ -x "$DST" ]] && "$DST" off || true
  rm -f "$DST" "$RULE"; echo "removed"; exit 0
fi

install -d -o root -g wheel -m 755 /usr/local/sbin
install -o root -g wheel -m 755 "$(dirname "$0")/fildi-awake" "$DST"
TMP=$(mktemp)
echo "$USER_NAME ALL=(root) NOPASSWD: $DST" > "$TMP"
visudo -cf "$TMP" >/dev/null                      # refuse a broken sudoers file
install -o root -g wheel -m 440 "$TMP" "$RULE"; rm -f "$TMP"
echo "installed: $DST (root-owned) + $RULE (that file only)"
sudo -u "$USER_NAME" sudo -n "$DST" check
