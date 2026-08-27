#!/bin/sh
# Assert the `pi` a shell would actually launch is the one hive-pi is built against (HIV-1037).
#
# Measured 2026-08-15, before this guard existed: the machine had ALREADY drifted, and
# nothing noticed. PATH order had flipped so ~/.local/bin/pi won over the ~/.npm-global
# pin the README still described, and that wrapper is three lines of
# `mise use -g pi` against `pi = "latest"` with MISE_MINIMUM_RELEASE_AGE=0 — it upgrades
# pi to whatever shipped, on every single launch, with the release-age quarantine off.
# Three versions were live at once: README said 0.83.0, ~/.npm-global/bin/pi was 0.84.0,
# mise resolved 0.84.1. That spread is the whole argument for a machine-checkable guard.
#
# The pin of record is the exact devDependency in package.json. It is the only candidate
# that is git-tracked, machine-independent and already enforced — CI typechecks against
# it, and HIV-1625 moved it 0.84.0 -> 0.84.1 behind an eval gate, so the team already
# treats that bump AS the pin change. README prose drifts (it did); `latest` is an anti-pin.
set -eu

repo_root=${1:-}
if [ -z "$repo_root" ]; then
	# Stowed into ~/.pi/agent/scripts as a symlink, so resolve to the real file first.
	repo_root=$(CDPATH= cd -- "$(dirname -- "$(readlink -f "$0")")/../../../.." && pwd)
fi
manifest="$repo_root/package.json"
[ -f "$manifest" ] || { echo "check-pin-drift: no package.json at $manifest" >&2; exit 2; }

# `// empty` matters: the same key also sits in peerDependencies as "*", so a grep would
# happily read the wildcard and call any version a match.
expected=$(jq -r '.devDependencies["@earendil-works/pi-coding-agent"] // empty' "$manifest")
[ -n "$expected" ] || { echo "check-pin-drift: no pi devDependency in $manifest" >&2; exit 2; }

launcher=$(command -v pi 2>/dev/null) || { echo "check-pin-drift: no pi on PATH" >&2; exit 2; }
real=$(readlink -f "$launcher")
# Both streams, not just stdout: every coloured line below is written to STDERR, so gating on
# stdout alone puts raw \033[31m into `check-pin-drift.sh 2>drift.log` run from a terminal
# (measured under a pty — the log held the escape bytes). Requiring stdout to be a tty as well
# keeps the ticket's literal rule for the `| tee` direction.
if [ -t 1 ] && [ -t 2 ]; then warn=$(printf '\033[31m'); off=$(printf '\033[0m'); else warn=''; off=''; fi

# Detect the self-upgrading launcher WITHOUT running it. `pi --version` through the mise
# wrapper executes `mise use -g pi` before exec: asking the question performs the upgrade
# this guard exists to catch, and can block on the network in a non-interactive timer.
#
# Gate on a SHELL shebang, not just any script: a correctly pinned npm install is
# `#!/usr/bin/env node` over a bundled cli.js, and that bundle contains the literal string
# "npx" (measured — 1 match). Grepping every launcher would report the one state we want
# to call healthy as UNPINNED. A real wrapper is a few lines of sh; the bundle never is.
if head -n 1 "$real" 2>/dev/null | grep -qE '^#!.*(sh|bash|zsh|dash)([[:space:]]|$)' &&
	grep -qE 'mise use|npx' "$real"; then
	printf '%scheck-pin-drift: pi is UNPINNED%s\n' "$warn" "$off" >&2
	printf '  expected: a fixed %s binary\n' "$expected" >&2
	printf '  actual:   self-upgrading launcher %s\n' "$real" >&2
	printf '            %s\n' "$(grep -m1 -E 'mise use|npx' "$real" | sed 's/^[[:space:]]*//')" >&2
	exit 1
fi

# The mise banner ("mise ~/.config/mise/config.toml tools: pi@0.84.1") goes to STDOUT, not
# stderr, so a naive capture returns two lines. Keep only a line that starts with a semver.
actual=$(pi --version 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' | head -n 1) || true
[ -n "$actual" ] || { echo "check-pin-drift: could not read a version from $real" >&2; exit 2; }

if [ "$actual" != "$expected" ]; then
	printf '%scheck-pin-drift: pi version drift%s\n' "$warn" "$off" >&2
	printf '  expected: %s (devDependency in %s)\n' "$expected" "$manifest" >&2
	printf '  actual:   %s (%s)\n' "$actual" "$real" >&2
	exit 1
fi

echo "check-pin-drift: ok — pi $actual at $real"
