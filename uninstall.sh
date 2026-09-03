#!/usr/bin/env bash
set -euo pipefail

PLUGIN_NAME="steamos-lact-toolkit"
TOOLKIT_VERSION="0.1.26"
if [[ -z "${DECK_HOME:-}" ]]; then
  if [[ -d /home/deck ]]; then
    DECK_HOME="/home/deck"
  elif [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    DECK_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  else
    DECK_HOME="${HOME}"
  fi
fi
PLUGIN_DIR="${DECK_HOME}/homebrew/plugins/${PLUGIN_NAME}"

as_root() {
  if [[ "$(id -u)" == "0" ]]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

check_sudo_access() {
  if [[ "$(id -u)" == "0" ]]; then
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    echo "This uninstaller needs sudo/root access, but sudo was not found." >&2
    exit 1
  fi
  if ! sudo -v; then
    echo "This uninstaller needs sudo/root access." >&2
    exit 1
  fi
}

steamos_readonly_enabled() {
  command -v steamos-readonly >/dev/null 2>&1 && [[ "$(steamos-readonly status 2>/dev/null || true)" == "enabled" ]]
}

with_writable_root() {
  local readonly_was_enabled=0
  if steamos_readonly_enabled; then
    as_root steamos-readonly disable
    readonly_was_enabled=1
  fi
  set +e
  "$@"
  local status=$?
  set -e
  if [[ "$readonly_was_enabled" == "1" ]]; then
    as_root steamos-readonly enable
  fi
  return "$status"
}

remove_system_files() {
  as_root systemctl disable --now steamos-lact-restore.timer 2>/dev/null || true
  as_root systemctl stop steamos-lact-restore.service 2>/dev/null || true
  as_root rm -f /etc/systemd/system/steamos-lact-restore.timer
  as_root rm -f /etc/systemd/system/steamos-lact-restore.service
  as_root rm -f /etc/atomic-update.conf.d/steamos-lact-toolkit.conf
  as_root rm -rf /etc/steamos-lact-toolkit
  as_root rm -f /var/lib/steamos-lact-toolkit/reboot-required
  as_root rmdir /var/lib/steamos-lact-toolkit 2>/dev/null || true
  as_root systemctl daemon-reload
}

verify_removed() {
  local remaining=0
  local path
  for path in \
    "$PLUGIN_DIR" \
    /etc/systemd/system/steamos-lact-restore.timer \
    /etc/systemd/system/steamos-lact-restore.service \
    /etc/atomic-update.conf.d/steamos-lact-toolkit.conf \
    /etc/steamos-lact-toolkit \
    /var/lib/steamos-lact-toolkit/reboot-required; do
    if as_root test -e "$path"; then
      echo "Still present: $path" >&2
      remaining=1
    fi
  done
  if [[ "$remaining" == "1" ]]; then
    echo "SteamOS LACT Toolkit uninstall did not remove every file listed above." >&2
    exit 1
  fi
}

echo "SteamOS LACT Toolkit uninstaller ${TOOLKIT_VERSION}"
check_sudo_access

as_root systemctl stop plugin_loader.service 2>/dev/null || true
as_root rm -rf "$PLUGIN_DIR"
with_writable_root remove_system_files
as_root systemctl reset-failed plugin_loader.service 2>/dev/null || true
as_root systemctl start plugin_loader.service 2>/dev/null || true
verify_removed

echo "SteamOS LACT Toolkit removed."
echo "LACT itself, lactd.service, /etc/lact, and AMD overdrive settings were left intact."
