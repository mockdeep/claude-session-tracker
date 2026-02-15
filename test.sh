#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRACKER="$SCRIPT_DIR/bin/claude-session-tracker"

# Use a temp state dir so we don't interfere with real sessions
export HOME=$(mktemp -d)
STATE_DIR="$HOME/.local/state/claude-sessions"
mkdir -p "$STATE_DIR"

# Set WINDOWID so session-start skips the slow PTY/xdotool lookup
export WINDOWID=12345

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

# --- session-start ---
echo "session-start"
echo '{"session_id":"test1","cwd":"/tmp/my-project"}' | "$TRACKER" session-start
assert_file_exists "$STATE_DIR/test1.json"
assert_json_eq "$STATE_DIR/test1.json" '.session_id' 'test1'
assert_json_eq "$STATE_DIR/test1.json" '.project_name' 'my-project'
assert_json_eq "$STATE_DIR/test1.json" '.cwd' '/tmp/my-project'
assert_json_eq "$STATE_DIR/test1.json" '.status' 'idle'
# timestamp should be ISO 8601
actual_ts=$(jq -r '.timestamp' "$STATE_DIR/test1.json")
if [[ "$actual_ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  inc_passed
else
  echo "  FAIL: timestamp '$actual_ts' doesn't match ISO 8601 format"
  inc_failed
fi

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

# --- unknown action fails ---
echo "unknown action"
if echo '{"session_id":"x","cwd":"/tmp"}' | "$TRACKER" bogus 2>/dev/null; then
  echo "  FAIL: expected nonzero exit for unknown action"
  inc_failed
else
  inc_passed
fi

# --- results ---
rm -rf "$HOME"
echo ""
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
