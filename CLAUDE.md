# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Cinnamon desktop panel applet + Claude Code hook script for tracking multiple Claude Code sessions. Two components communicate via JSON state files in `~/.local/state/claude-sessions/`:

- **`bin/claude-session-tracker`** — Bash script invoked by Claude Code hooks. Manages per-session JSON state files keyed by session ID. Actions: `session-start`, `notification-idle`, `notification-permission`, `prompt-submit`, `session-end`, `focus`.
- **`applet/claude-sessions@fletch/applet.js`** — Cinnamon applet (GJS/CJS). Monitors the state directory via polling, shows per-session colored dots in the panel. Each dot is individually clickable to focus its terminal window, with hover tooltips showing session details.

## Architecture

State flow: Claude Code hooks → stdin JSON → `claude-session-tracker` → writes `~/.local/state/claude-sessions/<session_id>.json` → applet polls directory mtime every 2s → reads all JSON files → updates panel.

Window focusing: The hook script finds the terminal window by writing a temporary marker to the PTY title and using `xdotool search`. The `focus` action uses `wmctrl -i -a` with hex window ID for cross-workspace activation.

Theme colors: On `session-start`, the hook walks up from `$cwd` looking for `.terminal-theme`, resolves the theme file from `$DOT_PATH/bash/terminal-themes/` (or `~/Dropbox/dotfiles/bash/terminal-themes/`), and extracts `prompt_fill` into `theme_color` in the session JSON. The applet renders each session as a colored dot using this value (fallback: `#cc241d`). Visual states: permission dots have a white border; idle and active dots have no border. Active (busy) dots pulse (opacity cycles 100–255) to convey work in progress; idle and permission dots stay at full opacity.

Focus tracking: The applet listens to `global.display` `notify::focus-window` to detect which window is active. When the focused window matches a session's `window_id`, a white underline bar appears beneath that dot. Each dot is clickable (focuses the session's terminal) and has a hover tooltip showing project name, status, and elapsed time (via the applet's `PanelItemTooltip`).

## Install & Test

```bash
./install.sh          # symlinks bin + applet, creates state dir, configures Claude hooks
```

Manual test (no build step):
```bash
echo '{"session_id":"test","cwd":"/tmp"}' | ~/.local/bin/claude-session-tracker notification-idle
cat ~/.local/state/claude-sessions/test.json
echo '{"session_id":"test","cwd":"/tmp"}' | ~/.local/bin/claude-session-tracker session-end
```

## Dependencies

Runtime: `xdotool`, `jq`, `wmctrl`, Cinnamon desktop. No build tools or package managers.

## Conventions

- Bash scripts use `set -euo pipefail`. State file writes use atomic tmp+mv pattern.
- Applet uses Cinnamon's CJS (imports.gi/imports.ui), not ES modules or Node.
- The applet hides itself when no sessions exist (count == 0). All sessions are shown (active, idle, permission).
- The applet extends `Applet.Applet` (not `TextIconApplet`) and manages its own `St.BoxLayout` of dot containers. Each container is a vertical `St.BoxLayout` holding a colored dot and a focus indicator bar.
