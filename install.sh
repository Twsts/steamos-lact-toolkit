#!/usr/bin/env bash
set -euo pipefail

REPO="Twsts/steamos-lact-toolkit"
ASSET="steamos-lact-toolkit.zip"
PLUGIN_NAME="steamos-lact-toolkit"
DECK_HOME="${DECK_HOME:-/home/deck}"
PLUGIN_DIR="${DECK_HOME}/homebrew/plugins/${PLUGIN_NAME}"

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

need_cmd curl
need_cmd unzip

if [[ "$(id -u)" != "0" ]]; then
  sudo -v
fi

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
