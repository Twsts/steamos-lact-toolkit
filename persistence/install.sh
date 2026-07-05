#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

READONLY_WAS_ENABLED=0
if command -v steamos-readonly >/dev/null 2>&1 && [[ "$(steamos-readonly status 2>/dev/null || true)" == "enabled" ]]; then
  steamos-readonly disable
  READONLY_WAS_ENABLED=1
fi

restore_readonly() {
  if [[ "${READONLY_WAS_ENABLED}" == "1" ]]; then
    steamos-readonly enable
  fi
}
trap restore_readonly EXIT

install -D -m 0644 "${SCRIPT_DIR}/atomic-update.conf" /etc/atomic-update.conf.d/steamos-lact-toolkit.conf
install -D -m 0755 "${SCRIPT_DIR}/steamos-lact-restore" /etc/steamos-lact-toolkit/steamos-lact-restore
install -D -m 0644 "${SCRIPT_DIR}/steamos-lact-restore.service" /etc/systemd/system/steamos-lact-restore.service
install -D -m 0644 "${SCRIPT_DIR}/steamos-lact-restore.timer" /etc/systemd/system/steamos-lact-restore.timer

systemctl daemon-reload
systemctl enable --now steamos-lact-restore.timer

echo "Installed SteamOS LACT Toolkit persistence."
echo "Run now with: sudo systemctl start steamos-lact-restore.service"
