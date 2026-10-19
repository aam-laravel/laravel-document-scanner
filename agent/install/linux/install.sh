#!/usr/bin/env sh
# Installs the agent for the current user and enables the systemd user service.
# Usage: ./install.sh [--yes]      Uninstall: ./install.sh --uninstall
set -eu

SRC_DIR=$(cd "$(dirname "$0")/../.." && pwd)
DEST="$HOME/.local/share/document-scanner-agent"
UNIT_DIR="$HOME/.config/systemd/user"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now document-scanner-agent.service 2>/dev/null || true
  rm -f "$UNIT_DIR/document-scanner-agent.service"
  rm -rf "$DEST"
  systemctl --user daemon-reload
  echo "Uninstalled (config in ~/.config/document-scanner-agent kept)."
  exit 0
fi

command -v node >/dev/null || { echo "node (>=20.10) is required" >&2; exit 1; }
command -v scanimage >/dev/null || echo "Warning: scanimage not found; install sane-utils (Debian/Ubuntu) or sane-backends." >&2

echo "This installs the agent to $DEST and enables a systemd user service that starts at login."
if [ "${1:-}" != "--yes" ]; then
  printf "Continue? [y/N] "
  read -r answer
  case "$answer" in y|Y|yes) ;; *) echo "Aborted."; exit 1 ;; esac
fi

mkdir -p "$DEST" "$UNIT_DIR" "$HOME/.local/state/document-scanner-agent"
cp -R "$SRC_DIR/bin" "$SRC_DIR/src" "$SRC_DIR/scripts" "$SRC_DIR/package.json" "$DEST/"
cp "$SRC_DIR/install/linux/document-scanner-agent.service" "$UNIT_DIR/"
systemctl --user daemon-reload
systemctl --user enable --now document-scanner-agent.service
echo "Installed. Status: systemctl --user status document-scanner-agent"
