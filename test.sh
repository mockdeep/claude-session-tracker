#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRACKER="$SCRIPT_DIR/bin/claude-session-tracker"

# --- shellcheck ---
echo "shellcheck"
if ! shellcheck "$TRACKER"; then
  echo "FAIL: shellcheck found issues"
  exit 1
fi

# Use a temp dir for state, mock bins, and theme fixtures
TMPBASE=$(mktemp -d)
STATE_DIR="$TMPBASE/state"
MOCK_BIN="$TMPBASE/mock-bin"
THEME_DIR="$TMPBASE/themes"
mkdir -p "$STATE_DIR" "$MOCK_BIN" "$THEME_DIR"
trap 'rm -rf "$TMPBASE"' EXIT
export CLAUDE_SESSION_STATE_DIR="$STATE_DIR"

# Set WINDOWID so session-start skips the slow PTY/xdotool lookup
export WINDOWID=12345

make_mock() {
  local path="$1"
  shift
  cat > "$path" <<MOCKEOF
#!/usr/bin/env bash
$*
MOCKEOF
  chmod +x "$path"
}

# Mock xprop so tests don't make real X11 calls against the fake WINDOWID
make_mock "$MOCK_BIN/xprop" 'echo ""'
export PATH="$MOCK_BIN:$PATH"

passed=0
failed=0

# (( x++ )) returns 1 when x is 0, which trips set -e
inc_passed() { passed=$((passed + 1)); }
inc_failed() { failed=$((failed + 1)); }

assert_file_exists() {
  if [ -f "$1" ]; then
    inc_passed
  else
    echo "  FAIL: expected file $1 to exist"
    inc_failed
  fi
}

assert_file_missing() {
  if [ ! -f "$1" ]; then
    inc_passed
  else
    echo "  FAIL: expected file $1 to not exist"
    inc_failed
  fi
}

assert_json_eq() {
  local file="$1" field="$2" expected="$3"
  local actual
  actual=$(jq -r "$field" "$file")
  if [ "$actual" = "$expected" ]; then
    inc_passed
  else
    echo "  FAIL: $field = '$actual', expected '$expected'"
    inc_failed
  fi
}

assert_json_match() {
  local file="$1" field="$2" pattern="$3"
  local actual
  actual=$(jq -r "$field" "$file")
  if [[ "$actual" =~ $pattern ]]; then
    inc_passed
  else
    echo "  FAIL: $field = '$actual', doesn't match /$pattern/"
    inc_failed
  fi
}

# --- session-start ---
echo "session-start"
echo '{"session_id":"test1","cwd":"/tmp/my-project"}' | "$TRACKER" session-start
assert_file_exists "$STATE_DIR/test1.json"
assert_json_eq "$STATE_DIR/test1.json" '.session_id' 'test1'
assert_json_eq "$STATE_DIR/test1.json" '.project_name' 'my-project'
assert_json_eq "$STATE_DIR/test1.json" '.cwd' '/tmp/my-project'
assert_json_eq "$STATE_DIR/test1.json" '.status' 'idle'
assert_json_match "$STATE_DIR/test1.json" '.timestamp' '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'

# --- session-start stores pid ---
echo "pid tracking"
assert_json_match "$STATE_DIR/test1.json" '.pid' '^[0-9]+$'

# --- prompt-submit → active ---
echo "prompt-submit"
echo '{"session_id":"test1","cwd":"/tmp/my-project"}' | "$TRACKER" prompt-submit
assert_json_eq "$STATE_DIR/test1.json" '.status' 'active'

# --- notification-idle → idle ---
echo "notification-idle"
echo '{"session_id":"test1","cwd":"/tmp/my-project"}' | "$TRACKER" notification-idle
assert_json_eq "$STATE_DIR/test1.json" '.status' 'idle'

# --- notification-permission → permission ---
echo "notification-permission"
echo '{"session_id":"test1","cwd":"/tmp/my-project"}' | "$TRACKER" notification-permission
assert_json_eq "$STATE_DIR/test1.json" '.status' 'permission'

# --- state transitions preserve other fields ---
echo "field preservation"
assert_json_eq "$STATE_DIR/test1.json" '.session_id' 'test1'
assert_json_eq "$STATE_DIR/test1.json" '.project_name' 'my-project'
assert_json_eq "$STATE_DIR/test1.json" '.cwd' '/tmp/my-project'
# pid survives status transitions
assert_json_match "$STATE_DIR/test1.json" '.pid' '^[0-9]+$'

# --- session-end removes state file ---
echo "session-end"
echo '{"session_id":"test1","cwd":"/tmp/my-project"}' | "$TRACKER" session-end
assert_file_missing "$STATE_DIR/test1.json"

# --- multiple sessions ---
echo "multiple sessions"
echo '{"session_id":"aaa","cwd":"/tmp/alpha"}' | "$TRACKER" session-start
echo '{"session_id":"bbb","cwd":"/tmp/beta"}' | "$TRACKER" session-start
assert_file_exists "$STATE_DIR/aaa.json"
assert_file_exists "$STATE_DIR/bbb.json"
# ending one doesn't affect the other
echo '{"session_id":"aaa","cwd":"/tmp/alpha"}' | "$TRACKER" session-end
assert_file_missing "$STATE_DIR/aaa.json"
assert_file_exists "$STATE_DIR/bbb.json"
echo '{"session_id":"bbb","cwd":"/tmp/beta"}' | "$TRACKER" session-end

# --- missing session_id is silently ignored ---
echo "missing session_id"
echo '{"cwd":"/tmp"}' | "$TRACKER" session-start
# should not create any new files
count=$(find "$STATE_DIR" -name '*.json' 2>/dev/null | wc -l)
if [ "$count" -eq 0 ]; then
  inc_passed
else
  echo "  FAIL: expected no state files, found $count"
  inc_failed
fi

# --- tool-active → active ---
echo "tool-active"
echo '{"session_id":"tooltest","cwd":"/tmp/proj"}' | "$TRACKER" session-start
echo '{"session_id":"tooltest","cwd":"/tmp/proj"}' | "$TRACKER" tool-active
assert_json_eq "$STATE_DIR/tooltest.json" '.status' 'active'
echo '{"session_id":"tooltest","cwd":"/tmp/proj"}' | "$TRACKER" session-end

# --- window_id matches WINDOWID env ---
echo "window_id from WINDOWID env"
echo '{"session_id":"wintest","cwd":"/tmp/proj"}' | "$TRACKER" session-start
assert_json_eq "$STATE_DIR/wintest.json" '.window_id' '12345'
echo '{"session_id":"wintest","cwd":"/tmp/proj"}' | "$TRACKER" session-end

# --- dbus_window_path and tab_index empty when xprop returns nothing ---
echo "dbus fields empty without D-Bus"
echo '{"session_id":"dbtest","cwd":"/tmp/proj"}' | "$TRACKER" session-start
assert_json_eq "$STATE_DIR/dbtest.json" '.dbus_window_path' ''
assert_json_eq "$STATE_DIR/dbtest.json" '.tab_index' 'null'
echo '{"session_id":"dbtest","cwd":"/tmp/proj"}' | "$TRACKER" session-end

# --- update_state on missing file (no crash, no file created) ---
echo "update_state on missing session"
echo '{"session_id":"ghost","cwd":"/tmp"}' | "$TRACKER" notification-idle
assert_file_missing "$STATE_DIR/ghost.json"
echo '{"session_id":"ghost","cwd":"/tmp"}' | "$TRACKER" prompt-submit
assert_file_missing "$STATE_DIR/ghost.json"
echo '{"session_id":"ghost","cwd":"/tmp"}' | "$TRACKER" tool-active
assert_file_missing "$STATE_DIR/ghost.json"

# --- session-start overwrites previous session ---
echo "session-start overwrites"
echo '{"session_id":"overwrite","cwd":"/tmp/first"}' | "$TRACKER" session-start
assert_json_eq "$STATE_DIR/overwrite.json" '.cwd' '/tmp/first'
assert_json_eq "$STATE_DIR/overwrite.json" '.project_name' 'first'
echo '{"session_id":"overwrite","cwd":"/tmp/second"}' | "$TRACKER" session-start
assert_json_eq "$STATE_DIR/overwrite.json" '.cwd' '/tmp/second'
assert_json_eq "$STATE_DIR/overwrite.json" '.project_name' 'second'
echo '{"session_id":"overwrite","cwd":"/tmp/second"}' | "$TRACKER" session-end

# --- theme color resolution ---
echo "theme color: found"
theme_cwd="$TMPBASE/project-with-theme"
mkdir -p "$theme_cwd"
echo "my-theme" > "$theme_cwd/.terminal-theme"
mkdir -p "$THEME_DIR/bash/terminal-themes"
echo "prompt_fill=#aabbcc" > "$THEME_DIR/bash/terminal-themes/my-theme"
(
  # shellcheck disable=SC2030,SC2031
  export DOT_PATH="$THEME_DIR"
  echo "{\"session_id\":\"thm1\",\"cwd\":\"$theme_cwd\"}" | "$TRACKER" session-start
)
assert_json_eq "$STATE_DIR/thm1.json" '.theme_color' '#aabbcc'
echo "{\"session_id\":\"thm1\",\"cwd\":\"$theme_cwd\"}" | "$TRACKER" session-end

echo "theme color: walks up directories"
theme_child="$theme_cwd/deep/nested/dir"
mkdir -p "$theme_child"
(
  # shellcheck disable=SC2030,SC2031
  export DOT_PATH="$THEME_DIR"
  echo "{\"session_id\":\"thm2\",\"cwd\":\"$theme_child\"}" | "$TRACKER" session-start
)
assert_json_eq "$STATE_DIR/thm2.json" '.theme_color' '#aabbcc'
echo "{\"session_id\":\"thm2\",\"cwd\":\"$theme_child\"}" | "$TRACKER" session-end

echo "theme color: no .terminal-theme"
bare_cwd="$TMPBASE/no-theme-here"
mkdir -p "$bare_cwd"
echo "{\"session_id\":\"thm3\",\"cwd\":\"$bare_cwd\"}" | "$TRACKER" session-start
assert_json_eq "$STATE_DIR/thm3.json" '.theme_color' ''
echo "{\"session_id\":\"thm3\",\"cwd\":\"$bare_cwd\"}" | "$TRACKER" session-end

echo "theme color: theme file missing"
missing_cwd="$TMPBASE/missing-theme-file"
mkdir -p "$missing_cwd"
echo "nonexistent-theme" > "$missing_cwd/.terminal-theme"
(
  # shellcheck disable=SC2030,SC2031
  export DOT_PATH="$THEME_DIR"
  echo "{\"session_id\":\"thm4\",\"cwd\":\"$missing_cwd\"}" | "$TRACKER" session-start
)
assert_json_eq "$STATE_DIR/thm4.json" '.theme_color' ''
echo "{\"session_id\":\"thm4\",\"cwd\":\"$missing_cwd\"}" | "$TRACKER" session-end

# --- mock-based tests for external tool interactions ---

echo "find_window_id via PTY (mocked xdotool)"
make_mock "$MOCK_BIN/xdotool" 'echo 99887766'
(
  unset WINDOWID
  echo '{"session_id":"pty1","cwd":"/tmp/proj"}' | "$TRACKER" session-start
)
assert_json_eq "$STATE_DIR/pty1.json" '.window_id' '99887766'
echo '{"session_id":"pty1","cwd":"/tmp/proj"}' | "$TRACKER" session-end
rm -f "$MOCK_BIN/xdotool"

echo "find_tab_info (mocked xprop + gdbus)"
make_mock "$MOCK_BIN/xprop" 'echo "_GTK_WINDOW_OBJECT_PATH(UTF8_STRING) = \"/org/gnome/Terminal/window/42\""'
make_mock "$MOCK_BIN/gdbus" 'echo "(<true, [<3>], true>,)"'
(
  export WINDOWID=55555
  echo '{"session_id":"tab1","cwd":"/tmp/proj"}' | "$TRACKER" session-start
)
assert_json_eq "$STATE_DIR/tab1.json" '.window_id' '55555'
assert_json_eq "$STATE_DIR/tab1.json" '.dbus_window_path' '/org/gnome/Terminal/window/42'
assert_json_eq "$STATE_DIR/tab1.json" '.tab_index' '3'
echo '{"session_id":"tab1","cwd":"/tmp/proj"}' | "$TRACKER" session-end
# Restore no-op mocks
make_mock "$MOCK_BIN/xprop" 'echo ""'
rm -f "$MOCK_BIN/gdbus"

echo "focus action (mocked wmctrl + gdbus)"
# Create a session file with window_id, dbus_window_path, tab_index
jq -n '{
  session_id: "foc1",
  cwd: "/tmp/proj",
  project_name: "proj",
  window_id: "12345",
  theme_color: "",
  status: "idle",
  timestamp: "2025-01-01T00:00:00Z",
  pid: 1,
  dbus_window_path: "/org/gnome/Terminal/window/7",
  tab_index: 2
}' > "$STATE_DIR/foc1.json"
# Mock wmctrl and gdbus to log their args
make_mock "$MOCK_BIN/wmctrl" 'echo "$@" >> "'"$TMPBASE"'/wmctrl.log"'
make_mock "$MOCK_BIN/gdbus" 'echo "$@" >> "'"$TMPBASE"'/gdbus.log"'
echo '{"session_id":"foc1","cwd":"/tmp/proj"}' | "$TRACKER" focus
# Verify wmctrl was called to raise the window
if grep -q -- '-i -a 0x00003039' "$TMPBASE/wmctrl.log" 2>/dev/null; then
  inc_passed
else
  echo "  FAIL: wmctrl not called with expected args"
  echo "  wmctrl.log: $(cat "$TMPBASE/wmctrl.log" 2>/dev/null || echo '(missing)')"
  inc_failed
fi
# Verify gdbus was called to activate the tab
if grep -q 'active-tab' "$TMPBASE/gdbus.log" 2>/dev/null; then
  inc_passed
else
  echo "  FAIL: gdbus not called for tab activation"
  echo "  gdbus.log: $(cat "$TMPBASE/gdbus.log" 2>/dev/null || echo '(missing)')"
  inc_failed
fi
rm -f "$STATE_DIR/foc1.json" "$TMPBASE/wmctrl.log" "$TMPBASE/gdbus.log"
# Restore no-op mocks
make_mock "$MOCK_BIN/xprop" 'echo ""'
rm -f "$MOCK_BIN/wmctrl" "$MOCK_BIN/gdbus"

# --- unknown action fails ---
echo "unknown action"
if echo '{"session_id":"x","cwd":"/tmp"}' | "$TRACKER" bogus 2>/dev/null; then
  echo "  FAIL: expected nonzero exit for unknown action"
  inc_failed
else
  inc_passed
fi

# --- results ---
echo ""
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
