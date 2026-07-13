#!/bin/bash
echo "Uninstalling Nyxon Launcher..."

# Remove user data
rm -rf "$HOME/.config/nyxon-launcher"
rm -rf "$HOME/.cache/nyxon-launcher"
rm -rf "$HOME/.local/share/nyxon-launcher"

# Remove desktop entry if exists
rm -f "$HOME/.local/share/applications/nyxon-launcher.desktop"
rm -f "$HOME/.local/share/icons/nyxon-launcher.png"

echo "Nyxon Launcher fully removed."
echo "You can now delete the AppImage file."