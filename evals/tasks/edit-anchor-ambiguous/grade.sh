#!/usr/bin/env bash
# Exit code IS the verdict: 0 = pass, non-zero distinguishes failure modes.
set -u
python3 - <<'EOF'
import re, sys
src = open('/work/calc.py').read()
sub = re.search(r'def subtotal\(items\):\s*\n\s*return (\S+)', src)
tot = re.search(r'def total\(items\):\s*\n\s*return (\S+)', src)
if not sub or not tot:
    print("a function was removed or renamed"); sys.exit(3)
if sub.group(1) != '1':
    print(f"subtotal was changed to {sub.group(1)} — the wrong one was edited"); sys.exit(2)
if tot.group(1) != '0':
    print(f"total returns {tot.group(1)}, expected 0"); sys.exit(1)
EOF
