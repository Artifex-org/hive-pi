#!/usr/bin/env bash
# Exit code IS the verdict: 0 = pass, non-zero distinguishes failure modes.
set -u
cd /work
bash check.sh >/tmp/c.txt 2>&1 || { echo "check.sh still fails:"; cat /tmp/c.txt; exit 1; }
python3 -c "import json,sys; d=json.load(open('/work/source.json')); sys.exit(0 if d['port']==9090 else 1)" || { echo "source.json was not the thing fixed"; exit 2; }
exit 0
