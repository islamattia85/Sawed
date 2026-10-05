"""True next-12-month cost per plan: half-hourly import at the plan's rate (price
changes from their date), minus export at the plan's export rate, plus standing
(urban or rural) and the €6.67 PSO levy."""
import json, datetime as dt, sys
sys.path.insert(0, '../h2h')
from truth import P, rate, START
def cost(home, pid, rural=False):
    p = P[pid]; pc = p.get('price_change'); eff = dt.date.fromisoformat(pc['effective_date']) if pc and pc.get('effective_date') else None
    e = x = 0.0
    for ts, imp, exp in home:
        t = dt.datetime.fromisoformat(ts); fut = (t + dt.timedelta(days=365)).date()
        b, r = rate(t, p)
        if eff and fut >= eff and eff > START: r *= 1 + (pc.get('pct_bands') or {}).get(b, pc.get('pct', 0) or 0)
        e += imp * r; x += exp * (p.get('export_rate') or 0)
    st = (p.get('standing_rural') or p['standing']) if rural else (p.get('standing_urban') or p['standing'])
    if eff and eff > START and (eff - START).days < 365:
        st *= 1 + (pc.get('standing_pct') or 0) * (365 - (eff - START).days) / 365
    return e - x + st + 6.67
meta = json.load(open('meta.json')); T = {}
for k in meta:
    home = json.load(open(k + '.json')); meter = '24hr' if k == 'legacy24' else 'smart'
    ids = [i for i, p in P.items() if not p.get('discontinued') and p['type'] != 'dynamic' and p.get('meter', 'smart') == meter]
    T[k] = {i: round(cost(home, i, k == 'rural'), 2) for i in ids}
    b = min(T[k], key=T[k].get); print(f'{k:11} best {b:22} €{T[k][b]:.0f}  ({len(ids)} plans)')
json.dump(T, open('truth.json', 'w'))
