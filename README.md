# Claude Session Tracker

A Cinnamon panel applet + Claude Code hook script for tracking multiple Claude Code sessions. Shows which sessions are waiting for input without spammy notifications.

## How It Works

Two components communicate via JSON state files in `~/.local/state/claude-sessions/`:

- **Hook script** — called by Claude Code hooks on session lifecycle events, writes state files
- **Cinnamon applet** — watches the state directory, shows a panel indicator when sessions need attention

The applet hides when all sessions are active. When a session goes idle or needs permission, it appears with a count badge. Click it to see waiting sessions, click a session to focus its terminal window.

## Prerequisites

- Cinnamon desktop environment
- `xdotool` — `sudo apt install xdotool`
- `jq` — `sudo apt install jq`

## Install

```bash
git clone https://github.com/fletch/claude-session-tracker.git
cd claude-session-tracker
./install.sh
```

The install script:
- Symlinks the hook script to `~/.local/bin/`
- Symlinks the applet to `~/.local/share/cinnamon/applets/`
- Creates the state directory
- Updates `~/.claude/settings.json` hooks (backs up first)

Then right-click your Cinnamon panel → Applets → find "Claude Sessions" → add to panel.

## Testing

```bash
# Simulate an idle session
echo '{"session_id":"test","cwd":"/tmp"}' | ~/.local/bin/claude-session-tracker notification-idle

# Check state file was created
cat ~/.local/state/claude-sessions/test.json

# Clean up
echo '{"session_id":"test","cwd":"/tmp"}' | ~/.local/bin/claude-session-tracker session-end
```

## Known Limitations

- If Claude crashes, `SessionEnd` never fires and the state file persists (stale)
- Window ID is captured at session start; if the terminal is closed/recreated, the ID is stale
- With terminal tabs, `xdotool` focuses the window but can't switch to a specific tab

## License

MIT
