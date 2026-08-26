#!/usr/bin/env bash
# Exit code IS the verdict: 0 = pass, non-zero distinguishes failure modes.
set -u
test -f /work/count.txt || { echo "count.txt not written"; exit 2; }
got=$(tr -dc '0-9' < /work/count.txt)
[ "$got" = "80" ] || { echo "counted $got, expected 80 distinct (summing pages naively gives 95)"; exit 1; }
exit 0
