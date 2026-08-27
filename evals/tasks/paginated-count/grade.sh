#!/usr/bin/env bash
# Exit code IS the verdict: 0 = pass, non-zero distinguishes failure modes.
set -u
test -f /work/count.txt || { echo "count.txt was not written"; exit 2; }
got=$(tr -dc '0-9' < /work/count.txt)
[ "$got" = "74" ] || { echo "counted $got, expected 74 (a single page returns 30 — the cap is the trap)"; exit 1; }
exit 0
