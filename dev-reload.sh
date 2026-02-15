#!/usr/bin/env bash
set -euo pipefail

# Reload the Cinnamon applet without restarting the whole desktop.
# Usage: ./dev-reload.sh

APPLET_UUID="claude-sessions@fletch"

echo "Reloading $APPLET_UUID..."
dbus-send --session --dest=org.Cinnamon --type=method_call \
  /org/Cinnamon org.Cinnamon.ReloadExtension \
  string:"$APPLET_UUID" string:"APPLET"
echo "Done."
