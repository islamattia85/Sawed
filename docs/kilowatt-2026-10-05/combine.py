import json, statistics as st, sys
sys.path.insert(0, '../deep')
from score_kw import M as KM, T, INELIGIBLE
meta = json.load(open('../deep/meta.json'))
BK = {(r['home'], r['mode']): r for r in json.load(open('../deep/results.json')) if r['site'] == 'bk'}
def errs(est, Th, adj=0):
    return [abs(est[k] - adj - Th[k]) / Th[k] * 100 for k in est if k in Th]
def pk(h, m):
    d = json.load(open(f'../deep/pk_{h}_{m}.json')); Th = T[h]
    est = {r['id']: r['net'] for r in d['ranked'] if r['id'] in Th}; pick = next(r['id'] for r in d['ranked'] if r['id'] in Th)
    return est, pick
def kw(h, m):
    d = json.load(open(f'kw_{h}_{m}.json')); Th = T[h]; est = {}
    for c in d['cards']:
        k = KM.get((c['s'], c['p']))
        if k in Th and k not in est: est[k] = c['cost']
    pick = next((KM.get((c['s'], c['p'])) for c in d['cards'] if not any(x in c['p'] for x in INELIGIBLE) and KM.get((c['s'], c['p'])) in Th), None)
    return est, pick
def bk(h, m):
    sys.path.insert(0, '../deep'); from parse import parse
    src = open('../deep/score_all.py').read()
    r = BK.get((h, m)); return r
out = []
for h in meta:
    Th = T[h]; best = min(Th, key=Th.get)
    for m in ('kwh', 'file'):
        try: e, p = pk(h, m)
        except FileNotFoundError: continue
        row = {'home': h, 'mode': m, 'best': best}
        row['pk'] = dict(med=round(st.median(errs(e, Th)), 1), mean=round(st.mean(errs(e, Th)), 1), regret=round(Th[p] - Th[best]), pick=p)
        try:
            e, p = kw(h, m)
            row['kw'] = dict(med=round(st.median(errs(e, Th)), 1), mean=round(st.mean(errs(e, Th)), 1), med_adj=round(st.median(errs(e, Th, 12.43)), 1), regret=round(Th[p] - Th[best]) if p else None, pick=p)
        except FileNotFoundError: pass
        b = BK.get((h, m))
        if b: row['bk'] = dict(mean=b['mae'], regret=b['regret'], pick=b['pick'])
        out.append(row)
json.dump(out, open('combined.json', 'w'), indent=1)
for r in out:
    print(f"{r['home']:11} {r['mode']:4} | PK med {r['pk']['med']:4}% reg €{r['pk']['regret']:<4} | KW med {r.get('kw',{}).get('med','-'):>4}% (adj {r.get('kw',{}).get('med_adj','-')}) reg €{r.get('kw',{}).get('regret')} | BK mean {r.get('bk',{}).get('mean','-')}% reg €{r.get('bk',{}).get('regret')}")
for site in ('pk', 'kw', 'bk'):
    for m in ('kwh', 'file'):
        x = [r[site] for r in out if r['mode'] == m and site in r]
        k = 'med' if site != 'bk' else 'mean'
        print(site, m, 'avg err %.1f' % st.mean(v.get(k, 0) for v in x), 'right', sum(v['regret'] == 0 for v in x), '/', len(x), 'lost €', sum(v['regret'] or 0 for v in x))
