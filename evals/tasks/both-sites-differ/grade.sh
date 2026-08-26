#!/usr/bin/env bash
# Exit code IS the verdict: 0 = pass, non-zero distinguishes failure modes.
set -u
python3 - <<'EOF'
import re, sys
src = open('/work/handlers.py').read()
a = re.search(r"def on_start\(ctx\):.*?return '([^']*)'", src, re.S)
b = re.search(r"def on_stop\(ctx\):.*?return '([^']*)'", src, re.S)
if not a or not b:
    print("a handler was removed or restructured"); sys.exit(3)
if a.group(1) != 'started':
    print(f"on_start returns {a.group(1)!r}"); sys.exit(1)
if b.group(1) != 'stopped':
    print(f"on_stop returns {b.group(1)!r}"); sys.exit(2)
if src.count("ctx.log('event')") != 2:
    print("the log calls were disturbed"); sys.exit(4)
EOF
