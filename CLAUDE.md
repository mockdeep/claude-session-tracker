# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Cinnamon desktop panel applet + Claude Code hook script for tracking multiple Claude Code sessions. Two components communicate via JSON state files in `~/.local/state/claude-sessions/`:

- **`bin/claude-session-tracker`** — Bash script invoked by Claude Code hooks. Manages per-session JSON state files keyed by session ID. Actions: `session-start`, `notification-idle`, `notification-permission`, `prompt-submit`, `session-end`, `focus`.
- **`applet/claude-sessions@fletch/applet.js`** — Cinnamon applet (GJS/CJS). Monitors the state directory with `Gio.FileMonitor`, shows a panel badge with count of waiting sessions, popup menu to focus individual terminal windows.

## Architecture

State flow: Claude Code hooks → stdin JSON → `claude-session-tracker` → writes `~/.local/state/claude-sessions/<session_id>.json` → applet's `Gio.FileMonitor` detects change → applet reads all JSON files → updates panel visibility/menu.

Window focusing: The hook script finds the terminal window by writing a temporary marker to the PTY title and using `xdotool search`. The `focus` action uses `wmctrl -i -a` with hex window ID for cross-workspace activation.

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
- The applet hides itself when no sessions need attention (count == 0).
