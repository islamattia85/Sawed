"""Score every site against the true next-12-month cost of each plan, per home."""
import json, re, statistics as st, sys, os
sys.path.insert(0, '.')
from parse import parse as bk_parse
import maps
T = json.load(open('truth.json')); V = json.load(open('truth_var.json')); meta = json.load(open('meta.json'))
G = json.load(open('truth_grid.json'))  # battery homes: each plan with the battery also filled from the grid
for h in V: T[h].update(V[h])
CORE = lambda Th: {k: v for k, v in Th.items() if '@' not in k}
ALT_OUT = ('EN-SMART-24-HOUR', 'EN-SMART', 'EN-24')  # Energia's own-site offers the comparison sites do not list

def sw_parse(f):
    PAY = ('Direct Debit', 'Pay on receipt of bill', 'Pay as you go', 'Credit/debit card')
    L = [x.strip() for x in open(f).read().split('\n')]; out = []
    for i, l in enumerate(L):
        if l == 'Estimated annual bill':
            j = i
            while j > 0 and L[j] not in PAY: j -= 1
            out.append((L[j - 1], float(L[i - 1].replace('€', '').replace(',', ''))))
    return out

def cards(site, key):
    """The site's list in its own order: (name, cost, id or None, open to a switcher)."""
    if site == 'pk':
        d = json.load(open(f'pk_{key}.json'))
        return [(r['id'], r['net'], r['id'], True) for r in d['ranked']], d.get('info', {})
    if site == 'bk':
        cs = bk_parse(f'bk_{key}.txt'); info = {}
        try: info = json.load(open(f'bk_{key}.meta.json'))
        except Exception: pass
        return [(c['s'] + ' ' + c['p'], c['cost'], maps.BK.get(c['s'] + '|' + c['p']), True) for c in cs], info
    if site == 'kw':
        d = json.load(open(f'kw_{key}.json'))
        return [(c['s'] + ' ' + c['p'], c['cost'], maps.KW.get(c['s'] + '|' + c['p']), not any(x in c['p'] for x in maps.KW_NOT_OPEN)) for c in d['cards'] if c['cost'] is not None], {'clicks': d['clicks'], 'secs': d['secs'], 'listed': d['n']}
    if site == 'sw':
        cs = sw_parse(f'sw_{key}.txt'); info = {}
        try: info = json.load(open(f'sw_{key}.meta.json'))
        except Exception: pass
        return [(n, c, maps.SW.get(n), not any(x in n for x in maps.SW_NOT_OPEN)) for n, c in cs], info
    if site == 'ep':
        d = json.load(open(f'ep_{key}.json'))
        kwh = re.search(r'Estimated Annual Import\s+([\d,]+) kWh', d['head']); exp = re.search(r'Estimated Annual Export\s+([\d,]+) kWh', d['head'])
        info = {'clicks': d['clicks'], 'secs': d['secs'], 'kwh': int(kwh.group(1).replace(',', '')) if kwh else None,
                'export_kwh': int(exp.group(1).replace(',', '')) if exp else None}
        return [(r['s'] + ' ' + r['p'], r['cost'], maps.EP.get(r['s'] + '|' + r['p']), not any(x in r['p'] for x in maps.EP_NOT_OPEN)) for r in d['rows']], info

def score(site, key, h, m):
    try: cs, info = cards(site, key)
    except FileNotFoundError: return None
    Th = T[h]; core = CORE(Th)
    est = {}; order = []
    for n, c, k, ok in cs:
        if k and k in Th and k not in est: est[k] = c; order.append(k)
    if not est: return dict(site=site, key=key, home=h, mode=m, n=0, listed=len(cs), first=cs[0][0] if cs else None, info=info)
    err = {k: (est[k] - Th[k]) / max(200, Th[k]) * 100 for k in est}
    best = min(core, key=core.get)
    alt = {k: v for k, v in core.items() if k not in ALT_OUT}; best_alt = min(alt, key=alt.get)
    first_any = next(((n, c, k) for n, c, k, ok in cs if ok), None)
    # The site's top plan a switcher can take. If it is one we cannot price, it is named, not scored.
    first_open = first_any[2] if first_any and first_any[2] in Th else None
    unscored_top = first_any[0] if first_any and first_any[2] not in Th else None
    base = lambda k: k.split('@')[0]
    seen = [base(k) for k in order]
    top3 = set(sorted(core, key=core.get)[:3])
    lost_alt_pick = (Th.get(first_open + '@28') or Th.get(first_open + '@23') or Th.get(first_open + '@26') or Th[first_open]) if first_open in ALT_OUT and first_open else (Th[first_open] if first_open else None)
    grid = {}
    if h in G:
        Gh = G[h]; ge = {k: (v - Gh[k]) / max(200, Gh[k]) * 100 for k, v in est.items() if k in Gh}; gb = min(Gh, key=Gh.get)
        grid = dict(g_mae=round(st.mean(abs(e) for e in ge.values()), 2), g_bias=round(st.mean(ge.values()), 2), g_best=gb, g_best_cost=round(Gh[gb]),
                    g_lost=round(Gh[first_open] - Gh[gb]) if first_open in Gh else None, g_best_rank=(seen.index(gb) + 1) if gb in seen else None,
                    g_pick_cost=round(Gh[first_open]) if first_open in Gh else None, g_pick_est=round(est[first_open]) if first_open in est else None)
    so = {}
    if site == 'pk':
        d = json.load(open(f'pk_{key}.json')); R = d.get('solar_only')
        if R:
            se = {r['id']: r['net'] for r in R if r['id'] in Th}; sp = R[0]['id']
            so = dict(so_pick=sp, so_est=R[0]['net'], so_lost=round(Th[sp] - core[best]) if sp in Th else None,
                      so_mae=round(st.mean(abs(v - Th[k]) / max(200, Th[k]) * 100 for k, v in se.items()), 2), so_true=round(Th[sp]) if sp in Th else None)
    return dict(**grid, **so, site=site, key=key, home=h, mode=m, n=len(est), listed=len(cs),
        mae=round(st.mean(abs(e) for e in err.values()), 2), med=round(st.median(abs(e) for e in err.values()), 2),
        bias=round(st.mean(err.values()), 2), maxe=round(max(abs(e) for e in err.values()), 1),
        within2=sum(abs(e) <= 2 for e in err.values()),
        pick=first_open, pick_name=first_any[0] if first_any else None, pick_shown=first_any[1] if first_any else None, unscored_top=unscored_top,
        best=best, best_cost=round(core[best]), lost=round(Th[first_open] - core[best]) if first_open else None,
        best_alt=best_alt, lost_alt=round(lost_alt_pick - alt[best_alt]) if first_open else None,
        best_rank=(seen.index(best) + 1) if best in seen else None,
        best_alt_rank=(seen.index(best_alt) + 1) if best_alt in seen else None,
        top3=len(top3 & set(seen[:3])), err={k: round(v, 2) for k, v in err.items()}, est=est, info=info)

SITES = ('pk', 'bk', 'kw', 'sw', 'ep')
SOLAR = ('solar', 'solar_batt', 'solar_mid', 'solar_ev')
def scenarios():
    """(group, site, file key, truth home, mode label)"""
    for h in meta:
        for m in ('kwh', 'file'):
            for st_ in SITES:
                key = f'{h}_{m}'
                if h in SOLAR and m == 'kwh' and st_ == 'kw': yield ('solar-before', st_, key, h, 'typed, before panels + system'); continue
                yield ('solar-' + ('after' if m == 'kwh' else 'file') if h in SOLAR else 'plans', st_, key, h, m)
        if h in SOLAR: yield ('solar-before', 'pk', f'{h}_before', h, 'typed, before panels + system')
    for tag, h in (('plan_solar', 'solar'), ('plan_solar_batt', 'solar_batt'), ('plan_solar_ev', 'solar_ev')):
        for st_ in ('pk', 'kw', 'ep'): yield ('planning', st_, tag, h, 'file before panels + system')
if __name__ == '__main__':
    rows = []
    for g, st_, key, h, m in scenarios():
        r = score(st_, key, h, m)
        if r: r['group'] = g; rows.append(r)
    json.dump(rows, open('scores5.json', 'w'), indent=1)
    for r in rows:
        if r.get('mae') is None: print(f"{r['group']:12} {r['key']:22} {r['site']} n 0 listed {r['listed']} first {r.get('first')}"); continue
        g = f"  | grid: err {r['g_mae']}% lost {r['g_lost']} best {r['g_best']}@{r['g_best_rank']}" if 'g_mae' in r else ''
        print(f"{r['group']:12} {r['key']:22} {r['site']} err {r['mae']:5}% med {r['med']:5} bias {r['bias']:+6} n {r['n']:2}/{r['listed']:3} pick {str(r['pick']):20} lost {str(r['lost']):>4} alt {str(r['lost_alt']):>4} best@{r['best_rank']} top3 {r['top3']}{g}")
