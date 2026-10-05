import json, statistics as s, sys
sys.path.insert(0, '.')
from parse import parse
import importlib.util
spec = importlib.util.spec_from_file_location('sc', '../h2h/score.py')
src = open('../h2h/score.py').read().split('def spearman')[0]; ns = {}; exec(src.replace('from parse import parse', ''), ns); M = ns['M']
M.update({'Ecopower|Standard Smart Electricity 10%': 'EP-SST', 'Ecopower|Smart 24hr Electricity 10%': 'EP-24',
  'Waterpower|Standard Electricity (eBill)': 'WP-24', 'SSE Airtricity|30% Electricity': 'SSE-24', 'Energia|Home Electricity': 'EN-24',
  'Flogas|Electricity 28% Loyalty Discount': 'FL-STD-24', 'Community Power|Standard Variable Electricity': 'CP-24',
  'Bord Gáis Energy|Electricity 28%': None})
T = json.load(open('truth.json')); meta = json.load(open('meta.json'))
from score_pk import score
rows = []
for h in meta:
    Th = T[h]; best = min(Th, key=Th.get)
    for m in ('kwh', 'file'):
        for site in ('bk', 'pk'):
            try:
                if site == 'pk':
                    d = json.load(open(f'pk_{h}_{m}.json')); r = score(d['ranked'], Th)
                    r['pickname'] = r['pick']
                else:
                    cards = parse(f'bk_{h}_{m}.txt'); ranked = []; first = None
                    for c in cards:
                        k = M.get(c['s'] + '|' + c['p'])
                        if first is None: first = (k, c['s'] + ' ' + c['p'], c['cost'])
                        if k and k in Th and all(x['id'] != k for x in ranked): ranked.append({'id': k, 'net': c['cost']})
                    r = score(ranked, Th); r['pick'] = first[0]; r['pickname'] = first[1]
                    r['regret'] = round(Th[first[0]] - Th[best]) if first[0] in Th else None
                    r['n_listed'] = len(cards)
                    try: r['meta'] = json.load(open(f'bk_{h}_{m}.meta.json'))
                    except Exception: pass
            except FileNotFoundError:
                continue
            r.update(home=h, mode=m, site=site, best=best, bestcost=round(Th[best])); rows.append(r)
json.dump(rows, open('results.json', 'w'), indent=1)
for r in rows: print(f"{r['home']:11} {r['mode']:4} {r['site']} MAE {r['mae']:5}% max {r['maxe']:5}% n {r['n']:2} pick {str(r['pickname'])[:38]:38} regret {r['regret']}")
