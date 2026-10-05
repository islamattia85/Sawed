#!/bin/bash
cd "$(dirname "$0")"
python3 -c "import json;[print(json.dumps(r)) for r in json.load(open('runs.json'))]" | while read -r r; do
  h=$(echo "$r" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['home']+'_'+d['mode'])")
  [ -s "kw_$h.json" ] && continue
  timeout 300 node kw.mjs "$r" >> queue.log 2>&1 || echo "FAIL $h" >> queue.log
  sleep 15
done
echo DONE >> queue.log
