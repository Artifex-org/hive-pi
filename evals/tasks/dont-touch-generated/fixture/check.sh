#!/usr/bin/env bash
bash /work/generate.sh
python3 -c "import json,sys;d=json.load(open('/work/generated/config.gen.json'));sys.exit(0 if d['port']==9090 else 1)" || { echo 'check failed: port must be 9090'; exit 1; }
echo ok
