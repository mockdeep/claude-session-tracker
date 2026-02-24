# Claude Session Tracker

A Cinnamon desktop extension + Claude Code hook script for tracking multiple Claude Code sessions. Shows a floating widget with colored session dots in the bottom-right corner of your screen.

## How It Works

Two components communicate via JSON state files in `~/.local/state/claude-sessions/`:

- **Hook script** (`bin/claude-session-tracker`) — called by Claude Code hooks on session lifecycle events (`session-start`, `notification-idle`, `notification-permission`, `prompt-submit`, `tool-active`, `session-end`), writes per-session JSON state files.
- **Cinnamon extension** (`extension/claude-sessions@fletch/extension.js`) — polls the state directory every second, renders a floating widget with colored dots arranged in a 2-column grid.

### Widget

The widget floats above all windows (via `Main.layoutManager.addChrome`) and auto-hides when no sessions exist. Each session is a colored dot. Hover shows a tooltip with status icon, project name, and elapsed time. Click a dot to focus its terminal window (and tab, for Gnome Terminal).

### Visual States

- **Active** (busy) — dot pulses opacity to convey work in progress
- **Idle** — steady dot, full opacity
- **Permission** — steady dot with white border (needs user input)
- **Focused** — white inner circle on the dot whose terminal window/tab is currently focused

### Theme Colors

On `session-start`, the hook walks up from the working directory looking for a `.terminal-theme` file, resolves the theme from `~/Dropbox/dotfiles/bash/terminal-themes/` (configurable via `$DOT_PATH`), and extracts the `prompt_fill` color. Each session dot uses this color (fallback: `#cc241d`).

### Window & Tab Focusing

On `session-start`, the hook captures the terminal's X window ID (via `$WINDOWID` or `xdotool getactivewindow`). Clicking a dot uses `wmctrl -i -a` for cross-workspace window activation.

For Gnome Terminal tabs, the hook also captures the D-Bus window object path (from `xprop`) and the active tab index. On focus, `gdbus` activates the stored tab. The extension subscribes to `org.gtk.Actions.Changed` D-Bus signals for instant tab-level focus detection.

### Stale Session Cleanup

The hook walks the process tree to find the actual `claude` PID and stores it in the session JSON. The extension reaps sessions whose PID no longer exists.

## Prerequisites

- Cinnamon desktop environment
- `xdotool` — `sudo apt install xdotool`
- `jq` — `sudo apt install jq`
- `wmctrl` — `sudo apt install wmctrl`
- `xprop` — typically pre-installed (part of `x11-utils`)
- `gdbus` — typically pre-installed (part of `libglib2.0-bin`)

## Install

```bash
git clone https://github.com/fletch/claude-session-tracker.git
cd claude-session-tracker
./install.sh
```

The install script:
- Symlinks the hook script to `~/.local/bin/`
- Symlinks the extension to `~/.local/share/cinnamon/extensions/`
- Creates the state directory `~/.local/state/claude-sessions/`
- Merges Claude Code hooks into `~/.claude/settings.json` (backs up first)

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

Note: manual test sessions created from a shell will be reaped by the extension's PID check (the hook's `$PPID` exits immediately). To test without reaping, write a JSON file directly with a long-lived PID (e.g. `"pid": 1`).

## Known Limitations

- If Claude crashes, `SessionEnd` never fires and the state file persists (stale PIDs are auto-reaped, but there may be a brief delay)
- Window ID is captured at session start; if the terminal window is closed and recreated, the stored ID is stale
- Tab focusing relies on Gnome Terminal's D-Bus interface; other terminal emulators will get window-level focus only

## License

MIT
