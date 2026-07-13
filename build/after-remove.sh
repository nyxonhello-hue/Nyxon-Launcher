#!/bin/bash
# Linux/universal uninstall cleanup for Nyxon Launcher.
#
# Removes Nyxon user configuration/cache from standard Linux locations.
# The AppImage itself is not removed here (user may remove it separately).

set -e

echo "Uninstalling Nyxon Launcher..."

NYXON_DATA="$HOME/.config/nyxon-launcher"
NYXON_CACHE="$HOME/.cache/nyxon-launcher"
NYXON_LOCAL="$HOME/.local/share/nyxon-launcher"

if [ -d "$NYXON_DATA" ]; then
  rm -rf "$NYXON_DATA"
  echo "Removed Nyxon user data."
fi

if [ -d "$NYXON_CACHE" ]; then
  rm -rf "$NYXON_CACHE"
  echo "Removed Nyxon cache."
fi

if [ -d "$NYXON_LOCAL" ]; then
  rm -rf "$NYXON_LOCAL"
  echo "Removed Nyxon local data."
fi

echo "Nyxon Launcher fully removed."
