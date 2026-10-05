"""True next-12-month cost of each plan for a home, from its half-hourly readings.
Independent of both sites: published rates and windows, exact per half hour,
announced price changes applied from their date, standing pro rata, PSO €6.67."""
import json, datetime as dt
P = {t['id']: t for t in json.load(open('/home/user/Sawed/public/tariffs.json')) if t.get('id') != '__meta__'}
START = dt.date(2026, 10, 5)
def inwin(h, w):
    if not w: return False
    a, b = w
    return a <= h < b if a < b else (h >= a or h < b)
def band(h, p):
    w = p.get('windows') or {}
    for k in ('wfh', 'ev', 'peak', 'night'):
        if inwin(h, w.get(k)): return k
    return 'day'
def rate(t, p):
    h = t.hour; b = band(h, p); base = p['rates'].get(b, p['rates'].get('day', 0))
    we = p.get('weekend'); dow = t.weekday()
    if we:
        if we.get('span'):
            (d0, h0), (d1, h1) = we['span']; at = dow*24+h; a = d0*24+h0; c = d1*24+h1
            inside = a <= at < c if a < c else (at >= a or at < c)
            if inside: base = we['rates'].get(b, base)
        elif dow in (we.get('days') or []) and (not we.get('window') or inwin(h, we['window'])):
            base = we['rates'].get(b, base)
    return b, base
def cost(home, pid):
    p = P[pid]; pc = p.get('price_change'); eff = dt.date.fromisoformat(pc['effective_date']) if pc and pc.get('effective_date') else None
    e = 0.0
    for ts, kwh in home:
        t = dt.datetime.fromisoformat(ts); fut = (t + dt.timedelta(days=365)).date()
        b, r = rate(t, p)
        if eff and fut >= eff and eff > START:
            r *= 1 + (pc.get('pct_bands') or {}).get(b, pc.get('pct', 0) or 0)
        e += kwh * r
    st = p['standing']
    if eff and eff > START and (eff - START).days < 365:
        st *= 1 + (pc.get('standing_pct') or 0) * (365 - (eff - START).days) / 365
    return e + st + 6.67
if __name__ == '__main__':
    import sys
    home = json.load(open(sys.argv[1] + '.json'))
    res = sorted(((cost(home, k), k) for k, p in P.items() if not p.get('discontinued') and p['type'] != 'dynamic' and p.get('meter', 'smart') == 'smart'), key=lambda x: x[0])
    json.dump({k: c for c, k in res}, open(sys.argv[1] + '_truth.json', 'w'))
    for c, k in res[:8]: print(f'{k:28} €{c:8.0f}  {P[k]["supplier"]} {P[k]["plan"]}')
