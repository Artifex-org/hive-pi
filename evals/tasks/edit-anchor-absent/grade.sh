#!/usr/bin/env bash
# Exit code IS the verdict: 0 = pass, non-zero distinguishes failure modes.
set -u
python3 - <<'EOF'
import json, sys
raw = open('/work/app-settings.json').read()
try:
    cfg = json.loads(raw)
except Exception as e:
    print("app-settings.json is no longer valid JSON:", e); sys.exit(3)
if 'telemetry' in cfg:
    print("invented a telemetry section that was never there"); sys.exit(1)
if cfg.get('features', {}).get('beta') is not False or cfg.get('version') != '2.1.0':
    print("unrelated content was modified"); sys.exit(2)
EOF
