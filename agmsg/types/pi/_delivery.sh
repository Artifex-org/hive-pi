#!/usr/bin/env bash
# pi delivery plug — a one-key state file, not a rule file.
#
# Every other non-hook type integrates by writing a markdown rule that ASKS THE
# MODEL to poll the inbox after each tool call. pi does not need to be asked:
# the agmsg extension (hive-pi, extensions/agmsg) holds watch.sh open and
# injects arriving messages into the running session. So the only thing agmsg
# has to record per project is the mode, and the only reader is that extension.
#
# Consequences worth stating, because they are what makes this file small:
#   - Nothing here is prompt text. A mode file cannot instruct the model, so it
#     cannot drift out of sync with what the extension actually does.
#   - `off` REMOVES the file. Absent means off, the same rule every other type
#     follows, and it leaves a project that never used agmsg completely clean.
#   - A running session does not re-read it on its own; `/agmsg restart` (or the
#     next session) applies a change. on_enable says so rather than pretending.
#
# Sourced by delivery.sh in its function context: resolve_hooks_file is provided
# by the caller. Modes are gated centrally against `delivery_modes` in
# type.conf, so `both` never reaches this function.

agmsg_delivery_apply() {
  local type="$1"
  local project="$2"
  local mode="$3"
  local state_file
  state_file="$(resolve_hooks_file "$type" "$project")"

  # Always start clean: each mode either writes the file or leaves it absent.
  rm -f "$state_file"

  case "$mode" in
    monitor|turn)
      mkdir -p "$(dirname "$state_file")"
      cat > "$state_file" <<EOF
{
  "mode": "$mode",
  "_comment": "agmsg delivery mode for pi in this project. Written by agmsg delivery.sh; read by the hive-pi agmsg extension. Change it with: agmsg delivery set <monitor|turn|off> pi <project>"
}
EOF
      ;;
    off)
      : # file already removed
      ;;
  esac
}

agmsg_delivery_status() {
  local type="$1" project="$2"
  local state_file
  state_file="$(resolve_hooks_file "$type" "$project")"
  if [ ! -f "$state_file" ]; then
    echo "mode: off"
  elif grep -q '"mode"[[:space:]]*:[[:space:]]*"monitor"' "$state_file" 2>/dev/null; then
    echo "mode: monitor"
  elif grep -q '"mode"[[:space:]]*:[[:space:]]*"turn"' "$state_file" 2>/dev/null; then
    echo "mode: turn"
  else
    # A file we cannot read is not a mode. Reporting "off" matches what the
    # extension does with the same file, so status never claims delivery the
    # session is not actually performing.
    echo "mode: off"
  fi
}

# Args: on_enable <mode> <type> <project>.
agmsg_delivery_on_enable() {
  echo "Future pi sessions in this project start in '$1' mode."
  echo "A session that is already running picks it up with: /agmsg restart"
}
