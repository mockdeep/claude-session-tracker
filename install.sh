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

# Symlink applet
mkdir -p "$HOME/.local/share/cinnamon/applets"
ln -sfn "$SCRIPT_DIR/applet/claude-sessions@fletch" "$HOME/.local/share/cinnamon/applets/claude-sessions@fletch"
echo "Linked applet → ~/.local/share/cinnamon/applets/claude-sessions@fletch/"

# Create state directory
mkdir -p "$HOME/.local/state/claude-sessions"
echo "Created ~/.local/state/claude-sessions/"

# Update Claude settings
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  BACKUP="${SETTINGS}.backup.$(date +%s)"
  cp "$SETTINGS" "$BACKUP"
  echo "Backed up settings to $BACKUP"

  jq '.hooks = {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "claude-session-tracker session-start"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "claude-session-tracker notification-permission"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "claude-session-tracker notification-idle"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "claude-session-tracker prompt-submit"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "claude-session-tracker session-end"
          }
        ]
      }
    ]
  }' "$SETTINGS" > "${SETTINGS}.tmp"
  mv "${SETTINGS}.tmp" "$SETTINGS"
  echo "Updated Claude hooks in settings.json"
else
  echo "Warning: $SETTINGS not found, skipping hook setup"
fi

echo ""
echo "Done! Next steps:"
echo "  1. Right-click your Cinnamon panel → Applets → find 'Claude Sessions' → add"
echo "  2. Start a Claude Code session to verify"
