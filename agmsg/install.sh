#!/usr/bin/env bash
set -euo pipefail

# Install the `pi` agent type into a local agmsg install.
#
# agmsg discovers external drivers under <install>/plugins/<axis>/<name>/ and
# IGNORES them until they are trusted — external drivers are shell code that
# runs with your privileges, so an unexpected drop-in must not execute. This
# script does the two steps that opt in: link the driver, then trust it.
#
# A SYMLINK, not a copy. The driver's source of truth is this repo, so an edit
# (or a `git pull` on the workstation) takes effect without a reinstall, and
# there is never a stale second copy to wonder about. The trust record pins the
# exact path, so replacing the link with something else de-trusts it — which is
# the property that makes trusting a symlink safe.
#
# Idempotent: re-running after an agmsg upgrade (which may replace plugins/) is
# the supported repair.
#
# Usage: agmsg/install.sh [--uninstall]

AGMSG_HOME="${AGMSG_HOME:-$HOME/.agents/skills/agmsg}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/types/pi"
TARGET_DIR="$AGMSG_HOME/plugins/types/pi"

if [ ! -x "$AGMSG_HOME/scripts/plugin.sh" ]; then
  echo "agmsg is not installed at $AGMSG_HOME (no scripts/plugin.sh)." >&2
  echo "Install agmsg first: https://agmsg.cc/" >&2
  exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
  "$AGMSG_HOME/scripts/plugin.sh" untrust types/pi || true
  # Only ever remove OUR symlink. A real directory there is somebody else's
  # driver and deleting it would be an unrequested, unrecoverable act.
  if [ -L "$TARGET_DIR" ]; then
    rm "$TARGET_DIR"
    echo "Removed $TARGET_DIR"
  elif [ -e "$TARGET_DIR" ]; then
    echo "Left $TARGET_DIR in place: it is not a symlink to this repo." >&2
  fi
  exit 0
fi

[ -f "$SOURCE_DIR/type.conf" ] || { echo "Driver source missing: $SOURCE_DIR" >&2; exit 1; }

mkdir -p "$(dirname "$TARGET_DIR")"

if [ -e "$TARGET_DIR" ] && [ ! -L "$TARGET_DIR" ]; then
  echo "$TARGET_DIR exists and is not a symlink — refusing to replace it." >&2
  exit 1
fi

ln -sfn "$SOURCE_DIR" "$TARGET_DIR"
"$AGMSG_HOME/scripts/plugin.sh" trust types/pi

echo
echo "pi is now a known agmsg agent type:"
"$AGMSG_HOME/scripts/whoami.sh" "$PWD" pi || true
