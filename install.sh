#!/usr/bin/env bash
set -euo pipefail

REPO="Twsts/steamos-lact-toolkit"
ASSET="steamos-lact-toolkit.zip"
PLUGIN_NAME="steamos-lact-toolkit"
if [[ -z "${DECK_HOME:-}" ]]; then
  if [[ -d /home/deck ]]; then
    DECK_HOME="/home/deck"
  elif [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    DECK_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  else
    DECK_HOME="${HOME}"
  fi
fi
DECK_USER="${DECK_USER:-$(basename "$DECK_HOME")}"
DECK_GROUP="${DECK_GROUP:-$(id -gn "$DECK_USER" 2>/dev/null || echo "$DECK_USER")}"
PLUGIN_DIR="${DECK_HOME}/homebrew/plugins/${PLUGIN_NAME}"
LACT_FLATPAK_ID="io.github.ilya_zlobintsev.LACT"
ASSUME_YES="${STEAMOS_LACT_ASSUME_YES:-0}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

as_root() {
  if [[ "$(id -u)" == "0" ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

as_deck_user() {
  if [[ "$(id -un)" == "$DECK_USER" ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "$DECK_USER" "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$DECK_USER" -- "$@"
  else
    echo "Cannot run command as ${DECK_USER}; sudo or runuser is required." >&2
    exit 1
  fi
}

check_sudo_access() {
  if [[ "$(id -u)" == "0" ]]; then
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    echo "This installer needs sudo/root access, but sudo was not found." >&2
    exit 1
  fi
  if ! sudo -v; then
    cat >&2 <<'EOF'
This installer needs sudo/root access to install Decky plugin files, services,
and LACT daemon helpers.

On SteamOS Desktop Mode, set a password for the current user first:

  passwd

Then run the installer again.
EOF
    exit 1
  fi
}

ask_yes_no() {
  local prompt="$1"
  local default="${2:-n}"
  local suffix="[y/N]"
  [[ "$default" == "y" ]] && suffix="[Y/n]"

  if [[ "$ASSUME_YES" == "1" ]]; then
    echo "${prompt} ${suffix} y"
    return 0
  fi

  if [[ ! -r /dev/tty ]]; then
    echo "${prompt} ${suffix} ${default} (no tty available)"
    [[ "$default" == "y" ]]
    return
  fi

  local answer
  while true; do
    read -r -p "${prompt} ${suffix} " answer </dev/tty
    answer="${answer:-$default}"
    case "${answer,,}" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
    esac
  done
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

flatpak_has_lact() {
  command -v flatpak >/dev/null 2>&1 && (
    as_deck_user flatpak info --user "$LACT_FLATPAK_ID" >/dev/null 2>&1 ||
    flatpak info --system "$LACT_FLATPAK_ID" >/dev/null 2>&1
  )
}

lactd_unit_exists() {
  systemctl list-unit-files lactd.service --no-legend 2>/dev/null | awk '{print $1}' | grep -qx lactd.service
}

wait_for_lact_socket() {
  local i
  for i in {1..10}; do
    if [[ -S /run/lactd.sock ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

flatpak_lact_install_path() {
  local user_path="${DECK_HOME}/.local/share/flatpak/app/${LACT_FLATPAK_ID}/x86_64/stable/active/files/bin/daemon.sh"
  local system_path="/var/lib/flatpak/app/${LACT_FLATPAK_ID}/x86_64/stable/active/files/bin/daemon.sh"
  if [[ -x "$user_path" ]]; then
    echo "$user_path"
  elif [[ -x "$system_path" ]]; then
    echo "$system_path"
  fi
}

install_lact_flatpak() {
  need_cmd flatpak
  if ! as_deck_user flatpak remote-list 2>/dev/null | awk '{print $1}' | grep -qx flathub; then
    echo "Adding Flathub remote for the ${DECK_USER} user."
    as_deck_user flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
  fi
  echo "Installing LACT Flatpak for the ${DECK_USER} user."
  as_deck_user flatpak install --user -y flathub "$LACT_FLATPAK_ID"
}

install_flatpak_lactd_service() {
  local daemon_sh="$1"
  local unit="/etc/systemd/system/lactd.service"

  local tmp_unit
  tmp_unit="$(mktemp)"
  cat >"$tmp_unit" <<EOF
[Unit]
Description=GPU Control Daemon (via Flatpak)
After=multi-user.target

[Service]
Environment=FLATPAK_INSTALL_USER=${DECK_USER}
ExecStart=bash ${daemon_sh}
Nice=-10
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
  as_root install -D -m 0644 "$tmp_unit" "$unit"
  rm -f "$tmp_unit"
  as_root systemctl daemon-reload
  as_root systemctl enable --now lactd.service
}

check_lact_setup() {
  echo "Checking LACT setup..."

  if command -v lact >/dev/null 2>&1; then
    echo "Found native LACT command: $(command -v lact)"
  elif flatpak_has_lact; then
    echo "Found LACT Flatpak."
  else
    echo "LACT was not found."
    if ask_yes_no "Install LACT Flatpak from Flathub for the ${DECK_USER} user?" "y"; then
      install_lact_flatpak
    else
      echo "Skipping LACT install. The Decky plugin needs lactd and /run/lactd.sock to tune the GPU."
    fi
  fi

  if lactd_unit_exists; then
    echo "Found lactd.service."
  elif flatpak_has_lact; then
    local daemon_sh
    daemon_sh="$(flatpak_lact_install_path || true)"
    if [[ -n "$daemon_sh" ]]; then
      echo "LACT Flatpak daemon helper found: $daemon_sh"
      if ask_yes_no "Install and enable lactd.service for the LACT Flatpak?" "y"; then
        with_writable_root install_flatpak_lactd_service "$daemon_sh"
      fi
    else
      echo "LACT Flatpak is installed, but daemon.sh was not found."
      echo "Open LACT in Desktop Mode and complete its daemon setup:"
      echo "  flatpak run ${LACT_FLATPAK_ID}"
    fi
  else
    echo "lactd.service was not found."
  fi

  if lactd_unit_exists && ! systemctl is-active --quiet lactd.service; then
    if ask_yes_no "Start/enable lactd.service now?" "y"; then
      as_root systemctl enable --now lactd.service
    fi
  fi

  if wait_for_lact_socket; then
    echo "LACT socket OK: /run/lactd.sock"
  else
    if flatpak_has_lact; then
      local daemon_sh
      daemon_sh="$(flatpak_lact_install_path || true)"
      if [[ -n "$daemon_sh" ]] && ask_yes_no "Repair/reinstall lactd.service for the LACT Flatpak?" "y"; then
        with_writable_root install_flatpak_lactd_service "$daemon_sh"
      fi
    fi

    if wait_for_lact_socket; then
      echo "LACT socket OK: /run/lactd.sock"
    else
      echo "WARNING: /run/lactd.sock is missing."
      echo "The plugin can install, but it will not work until lactd is running."
      echo "Check with: systemctl status lactd --no-pager"
    fi
  fi
}

check_decky_plugin_health() {
  local since="$1"
  local logs

  echo "Checking Decky plugin startup..."
  sleep 5

  if ! systemctl is-active --quiet plugin_loader.service; then
    echo "WARNING: plugin_loader.service is not active after install." >&2
    echo "Check with: systemctl status plugin_loader.service --no-pager -l" >&2
    return 1
  fi

  logs="$(as_root journalctl -u plugin_loader.service --since "$since" --no-pager -o cat 2>/dev/null || true)"

  if grep -Eq "SteamOS LACT Toolkit plugin loaded|Loaded SteamOS LACT Toolkit" <<<"$logs"; then
    echo "Decky backend OK: SteamOS LACT Toolkit loaded."
  else
    echo "NOTE: SteamOS LACT Toolkit was not seen in the Decky log yet." >&2
    echo "This can be normal when installing from Desktop Mode before returning to Gaming Mode." >&2
    echo "Return to Gaming Mode, then open Decky. If the plugin is missing, restart Steam or reboot." >&2
    echo "Debug log: journalctl -u plugin_loader.service -n 180 --no-pager -o cat" >&2
    return 0
  fi

  if grep -Eiq "SteamOS LACT Toolkit .*failed|NoneType|address already in use|Failed to start SteamDeck Plugin Loader" <<<"$logs"; then
    echo "WARNING: Decky log contains errors after install." >&2
    echo "Debug log: journalctl -u plugin_loader.service -n 180 --no-pager -o cat" >&2
    return 1
  fi
}

need_cmd curl
need_cmd unzip

if ! id "$DECK_USER" >/dev/null 2>&1; then
  cat >&2 <<EOF
Target user '${DECK_USER}' was not found.

Set DECK_HOME and DECK_USER explicitly, then run the installer again. Example:

  DECK_HOME=/home/youruser DECK_USER=youruser bash install.sh
EOF
  exit 1
fi

check_sudo_access

check_lact_setup

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

url="https://github.com/${REPO}/releases/latest/download/${ASSET}"
echo "Downloading ${url}"
curl -fL "$url" -o "${tmp}/${ASSET}"
unzip -q "${tmp}/${ASSET}" -d "$tmp"

if [[ ! -d "${tmp}/steamos-lact-toolkit/decky" ]]; then
  echo "Release asset did not contain steamos-lact-toolkit/decky" >&2
  exit 1
fi

decky_restart_since="$(date '+%Y-%m-%d %H:%M:%S')"
as_root systemctl stop plugin_loader.service 2>/dev/null || true
as_root rm -rf "$PLUGIN_DIR"
as_root install -d -o "$DECK_USER" -g "$DECK_GROUP" "$PLUGIN_DIR"
as_root cp -a "${tmp}/steamos-lact-toolkit/decky/." "$PLUGIN_DIR/"
as_root rm -rf "${PLUGIN_DIR}/node_modules" "${PLUGIN_DIR}/__pycache__"
as_root chown -R "${DECK_USER}:${DECK_GROUP}" "$PLUGIN_DIR"

as_root "${tmp}/steamos-lact-toolkit/persistence/install.sh"

as_root systemctl reset-failed plugin_loader.service 2>/dev/null || true
as_root systemctl start plugin_loader.service

check_decky_plugin_health "$decky_restart_since" || true

echo "SteamOS LACT Toolkit installed."
echo "If you installed from Desktop Mode, return to Gaming Mode to use the Decky plugin UI."
