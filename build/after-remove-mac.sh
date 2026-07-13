#!/bin/bash
# macOS post-uninstall cleanup for Nyxon Launcher.
#
# The packaging/uninstaller can run this script after removing the app.
# It tries to remove Nyxon-specific user data, cached files and
# preferences so the system is left in a clean state.

set -e

echo "Cleaning up Nyxon Launcher..."

# Remove user data + app support
rm -rf "$HOME/Library/Application Support/nyxon-launcher"
rm -rf "$HOME/Library/Application Support/Nyxon Launcher"

# Remove caches
rm -rf "$HOME/Library/Caches/nyxon-launcher"

# Remove preferences
rm -rf "$HOME/Library/Preferences/com.nyxon.launcher.plist"

# Remove saved application state (macOS specific)
rm -rf "$HOME/Library/Saved Application State/com.nyxon.launcher.savedState"

echo "Nyxon Launcher fully removed."
