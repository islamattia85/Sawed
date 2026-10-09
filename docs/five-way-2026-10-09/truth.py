"""True next-12-month cost of every plan for a home, from its half-hourly readings.
Independent of every site's own sums: each plan's published rates and hours,
exact per half hour; an announced price change applied from its date; standing
(urban or rural) pro rata across a change; the PSO levy (EUR 6.67 inc VAT a year);
export paid at the plan's rate. Cashback and welcome credits are left out."""
import json, datetime as dt
P = {t['id']: t for t in json.load(open('/home/user/Sawed/public/tariffs.json')) if t.get('id') != '__meta__'}
START = dt.date(2026, 10, 9)
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
def cost(home, pid, rural=False):
    p = P[pid]; pc = p.get('price_change'); eff = dt.date.fromisoformat(pc['effective_date']) if pc and pc.get('effective_date') else None
    e = x = 0.0
    for ts, imp, exp in home:
        t = dt.datetime.fromisoformat(ts); fut = (t + dt.timedelta(days=365)).date()
        b, r = rate(t, p)
        if eff and fut >= eff and eff > START: r *= 1 + (pc.get('pct_bands') or {}).get(b, pc.get('pct', 0) or 0)
        e += imp * r; x += exp * (p.get('export_rate') or 0)
    st = (p.get('standing_rural') or p['standing']) if rural else p['standing']
    if eff and eff > START and (eff - START).days < 365:
        st *= 1 + (pc.get('standing_pct') or 0) * (365 - (eff - START).days) / 365
    return e - x + st + 6.67
if __name__ == '__main__':
    meta = json.load(open('meta.json')); T = {}
    for k in meta:
        # A home whose panels went in partway is priced on the year ahead, with them all year.
        try: home = json.load(open(k + '_ahead.json'))
        except FileNotFoundError: home = json.load(open(k + '.json'))
        meter = '24hr' if k == 'legacy24' else 'smart'
        ids = [i for i, p in P.items() if not p.get('discontinued') and not p.get('on_hold') and p['type'] != 'dynamic' and p.get('meter', 'smart') == meter]
        T[k] = {i: round(cost(home, i, k == 'rural'), 2) for i in ids}
        b = min(T[k], key=T[k].get); print(f'{k:11} best {b:22} EUR{T[k][b]:.0f}  ({len(ids)} plans)  {P[b]["supplier"]} {P[b]["plan"]}')
    json.dump(T, open('truth.json', 'w'))
