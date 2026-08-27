#!/usr/bin/env bash
mkdir -p /work/generated
python3 -c "import json;d=json.load(open('/work/source.json'));d['generated']=True;json.dump(d,open('/work/generated/config.gen.json','w'),indent=2)"
