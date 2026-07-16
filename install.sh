#!/usr/bin/env bash
set -euo pipefail

REPO="Twsts/steamos-lact-toolkit"
ASSET="steamos-lact-toolkit.zip"
PLUGIN_NAME="steamos-lact-toolkit"
DECK_HOME="${DECK_HOME:-/home/deck}"
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
    flatpak info --user "$LACT_FLATPAK_ID" >/dev/null 2>&1 ||
    flatpak info --system "$LACT_FLATPAK_ID" >/dev/null 2>&1
  )
}

lactd_unit_exists() {
  systemctl list-unit-files lactd.service --no-legend 2>/dev/null | awk '{print $1}' | grep -qx lactd.service
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
  if ! sudo -u deck flatpak remote-list 2>/dev/null | awk '{print $1}' | grep -qx flathub; then
    echo "Adding Flathub remote for the deck user."
    sudo -u deck flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
  fi
  echo "Installing LACT Flatpak for the deck user."
  sudo -u deck flatpak install --user -y flathub "$LACT_FLATPAK_ID"
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
Environment=FLATPAK_INSTALL_USER=deck
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
    if ask_yes_no "Install LACT Flatpak from Flathub for the deck user?" "y"; then
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

  if [[ -S /run/lactd.sock ]]; then
    echo "LACT socket OK: /run/lactd.sock"
  else
    echo "WARNING: /run/lactd.sock is missing."
    echo "The plugin can install, but it will not work until lactd is running."
    echo "Check with: systemctl status lactd --no-pager"
  fi
}

need_cmd curl
need_cmd unzip

if [[ "$(id -u)" != "0" ]]; then
  sudo -v
fi

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

as_root systemctl stop plugin_loader.service 2>/dev/null || true
as_root rm -rf "$PLUGIN_DIR"
as_root install -d -o deck -g deck "$PLUGIN_DIR"
as_root cp -a "${tmp}/steamos-lact-toolkit/decky/." "$PLUGIN_DIR/"
as_root rm -rf "${PLUGIN_DIR}/node_modules" "${PLUGIN_DIR}/__pycache__"
as_root chown -R deck:deck "$PLUGIN_DIR"

as_root "${tmp}/steamos-lact-toolkit/persistence/install.sh"

as_root systemctl reset-failed plugin_loader.service 2>/dev/null || true
as_root systemctl start plugin_loader.service

echo "SteamOS LACT Toolkit installed."
