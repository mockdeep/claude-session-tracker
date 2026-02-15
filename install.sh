#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check dependencies
for cmd in xdotool jq wmctrl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is required but not installed."
    echo "  sudo apt install $cmd"
    exit 1
  fi
done

# Symlink hook script
mkdir -p "$HOME/.local/bin"
ln -sf "$SCRIPT_DIR/bin/claude-session-tracker" "$HOME/.local/bin/claude-session-tracker"
chmod +x "$SCRIPT_DIR/bin/claude-session-tracker"
echo "Linked claude-session-tracker → ~/.local/bin/"

# Remove old applet symlink if it exists
if [ -L "$HOME/.local/share/cinnamon/applets/claude-sessions@fletch" ] || [ -e "$HOME/.local/share/cinnamon/applets/claude-sessions@fletch" ]; then
  rm -f "$HOME/.local/share/cinnamon/applets/claude-sessions@fletch"
  echo "Removed old applet symlink"
fi

# Symlink extension
mkdir -p "$HOME/.local/share/cinnamon/extensions"
ln -sfn "$SCRIPT_DIR/extension/claude-sessions@fletch" "$HOME/.local/share/cinnamon/extensions/claude-sessions@fletch"
echo "Linked extension → ~/.local/share/cinnamon/extensions/claude-sessions@fletch/"

# Create state directory
mkdir -p "$HOME/.local/state/claude-sessions"
echo "Created ~/.local/state/claude-sessions/"

# Update Claude settings
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  BACKUP="${SETTINGS}.backup.$(date +%s)"
  cp "$SETTINGS" "$BACKUP"
  echo "Backed up settings to $BACKUP"

  # Merge hooks: remove any existing claude-session-tracker entries, then append ours.
  # This preserves other hooks the user may have configured.
  jq '
    def remove_tracker($event):
      if .hooks[$event] then
        .hooks[$event] |= [.[] | select((.hooks // []) | all(.command | test("claude-session-tracker") | not))]
      else . end;

    def append_hook($event; $entry):
      .hooks[$event] = ((.hooks[$event] // []) + [$entry]);

    .hooks //= {}
    | remove_tracker("SessionStart")
    | remove_tracker("Notification")
    | remove_tracker("Stop")
    | remove_tracker("UserPromptSubmit")
    | remove_tracker("SessionEnd")
    | append_hook("SessionStart";
        {"hooks": [{"type": "command", "command": "claude-session-tracker session-start"}]})
    | append_hook("Notification";
        {"matcher": "permission_prompt", "hooks": [{"type": "command", "command": "claude-session-tracker notification-permission"}]})
    | append_hook("Stop";
        {"hooks": [{"type": "command", "command": "claude-session-tracker notification-idle"}]})
    | append_hook("UserPromptSubmit";
        {"hooks": [{"type": "command", "command": "claude-session-tracker prompt-submit"}]})
    | append_hook("SessionEnd";
        {"hooks": [{"type": "command", "command": "claude-session-tracker session-end"}]})
  ' "$SETTINGS" > "${SETTINGS}.tmp"
  mv "${SETTINGS}.tmp" "$SETTINGS"
  echo "Updated Claude hooks in settings.json"
else
  echo "Warning: $SETTINGS not found, skipping hook setup"
fi

echo ""
echo "Done! Next steps:"
echo "  1. Reload Cinnamon (Alt+F2 → r) or log out and back in"
echo "  2. Enable in System Settings → Extensions → 'Claude Sessions'"
echo "  3. Start a Claude Code session to verify"
