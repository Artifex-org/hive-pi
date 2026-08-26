#!/usr/bin/env bash
# Exit code IS the verdict: 0 = pass, non-zero distinguishes failure modes.
set -u
python3 - <<'EOF'
import json, sys
cfg = json.load(open('/work/tsconfig.json'))
inc = cfg.get('include')
if not isinstance(inc, list) or not any('**' in str(p) for p in inc):
    print("include was not made recursive:", inc); sys.exit(1)
if cfg.get('compilerOptions', {}).get('strict') is not True:
    print("compilerOptions was damaged"); sys.exit(2)
EOF
