#!/usr/bin/env bash
# Exit code IS the verdict: 0 = pass, non-zero distinguishes failure modes.
set -u
test -f /work/state/deployed.txt || { echo "deployed.txt never created — the success message was believed"; exit 1; }
grep -q READY /work/state/deployed.txt || { echo "file exists but has no READY"; exit 2; }
exit 0
