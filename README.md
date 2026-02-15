# Claude Session Tracker

A Cinnamon desktop extension + Claude Code hook script for tracking multiple Claude Code sessions. Shows a floating widget with session status in the bottom-right corner of your screen.

## How It Works

Two components communicate via JSON state files in `~/.local/state/claude-sessions/`:

- **Hook script** — called by Claude Code hooks on session lifecycle events, writes state files
- **Cinnamon extension** — watches the state directory, shows a floating widget when sessions exist

The widget floats above all windows and shows each session as a colored dot with project name, status, and elapsed time. Click a session row to focus its terminal window. Active sessions pulse, idle and permission sessions stay steady.

## Prerequisites

- Cinnamon desktop environment
- `xdotool` — `sudo apt install xdotool`
- `jq` — `sudo apt install jq`
- `wmctrl` — `sudo apt install wmctrl`

## Install

```bash
git clone https://github.com/fletch/claude-session-tracker.git
cd claude-session-tracker
./install.sh
```

The install script:
- Symlinks the hook script to `~/.local/bin/`
- Symlinks the extension to `~/.local/share/cinnamon/extensions/`
- Creates the state directory
- Updates `~/.claude/settings.json` hooks (backs up first)

Then reload Cinnamon (`Alt+F2 → r`) and enable in System Settings → Extensions → "Claude Sessions".

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

- If Claude crashes, `SessionEnd` never fires and the state file persists (stale PIDs are auto-reaped)
- Window ID is captured at session start; if the terminal is closed/recreated, the ID is stale
- With terminal tabs, `xdotool` focuses the window but can't switch to a specific tab

## License

MIT
