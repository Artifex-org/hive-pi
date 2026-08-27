#!/usr/bin/env bash
# pi driver hook: does a resumable session exist for <uuid>?
#
# pi stores sessions per working directory:
#
#   ~/.pi/agent/sessions/--<munged-cwd>--/<ISO-timestamp>_<uuid>.jsonl
#
# where <munged-cwd> is the absolute path with its leading separator stripped
# and every '/', '\' and ':' replaced by '-'. Case and underscores are
# preserved, and runs are NOT collapsed — verified against pi 0.84
# (core/session-manager.js: `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g,
# "-")}--`), e.g.
#   /home/dev/repos/Aurora__worktrees -> --home-dev-repos-Aurora__worktrees--
#
# The timestamp prefix means the uuid alone does not name the file, so this
# globs for the suffix rather than testing one path.
#
# This layout is pi's INTERNAL business, which is exactly why the knowledge
# lives in the driver: spawn.sh only ever asks "does a transcript exist?".
# Every failure path (unset HOME, no such directory, empty args) returns
# non-zero = "not found", so the resume-or-fresh gate fails open to a FRESH
# session rather than resuming a phantom id.
#
# Sourced by spawn.sh when the type declares resume_arg; defines:
#   agmsg_transcript_exists <uuid> <project>  -> 0 if a session file exists

agmsg_transcript_exists() {
  local uuid="$1" project="$2" base munged file
  [ -n "$uuid" ] && [ -n "$project" ] || return 1

  # Honour pi's own overrides, in pi's precedence order, before falling back to
  # the default location under $HOME.
  if [ -n "${PI_CODING_AGENT_SESSION_DIR:-}" ]; then
    base="$PI_CODING_AGENT_SESSION_DIR"
  elif [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
    base="$PI_CODING_AGENT_DIR/sessions"
  else
    [ -n "${HOME:-}" ] || return 1
    base="$HOME/.pi/agent/sessions"
  fi

  munged="--$(printf '%s' "$project" | LC_ALL=C sed -e 's#^[/\\]##' -e 's#[/\\:]#-#g')--" || return 1
  [ -d "$base/$munged" ] || return 1

  for file in "$base/$munged"/*_"$uuid".jsonl; do
    [ -f "$file" ] && return 0
  done
  return 1
}
