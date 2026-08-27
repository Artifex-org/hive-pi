#!/usr/bin/env bash
# Exit code IS the verdict: 0 = pass, non-zero distinguishes failure modes.
set -u
python3 - <<'EOF'
import re, sys
src = open('/work/server.py').read()
if 'DEFAULT_PORT = 9090' not in src and '9090' not in src:
    print("9090 does not appear anywhere — the change was not made"); sys.exit(1)
if not re.search(r"PORT = int\(__import__\('os'\)\.environ\.get\('PORT', DEFAULT_PORT\)\)", src):
    print("the computed PORT line was clobbered — the prompt's quoted line did not exist verbatim"); sys.exit(2)
if 'def serve' not in src:
    print("unrelated code was removed"); sys.exit(3)
EOF
