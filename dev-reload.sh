#!/usr/bin/env bash
set -euo pipefail

# Reload the Cinnamon extension without restarting the whole desktop.
# Usage: ./dev-reload.sh

EXT_UUID="claude-sessions@fletch"

echo "Reloading $EXT_UUID..."
dbus-send --session --dest=org.Cinnamon --type=method_call \
  /org/Cinnamon org.Cinnamon.ReloadExtension \
  string:"$EXT_UUID" string:"EXTENSION"
echo "Done."
