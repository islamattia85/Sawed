import json, os, subprocess, sys
S = '/tmp/claude-0/-home-user-Sawed/74c17acb-5048-514f-a9cb-512d72f36e1c/scratchpad'
SC = '/home/user/Sawed/tests/fixtures/meter-scenarios/score.py'
C = ['ad1de59', '123f0ba', '5179c9f', '3a8346b', 'e22e94a']
res = {}
for c in C:
    d = f'{S}/step0b/{c}'
    if not os.path.isdir(d): continue
    subprocess.run([sys.executable, SC, d], capture_output=True)
    res[c] = {r['id']: r for r in json.load(open(f'{d}/scores.json'))}
json.dump(res, open(f'{S}/step0b/table.json', 'w'), indent=1)
ids = sorted({i for c in res for i in res[c]}, key=lambda x: (x[0], x))
for i in ids:
    cells = []
    for c in C:
        r = res.get(c, {}).get(i)
        if not r: cells.append(f'{c}: —'); continue
        if r['outcome'] == 'rejected': cells.append(f'{c}: rejected'); continue
        cells.append(f"{c}: use {r['kwh_err']:+6}% gap {r['price_gap']:5}% pb {r.get('payback')}/{r.get('true_payback')}")
    print(f'{i:22}', ' | '.join(cells))
