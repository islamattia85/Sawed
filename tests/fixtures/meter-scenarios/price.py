"""True cost of a plan for the year ahead, from half-hour readings.

Each plan's published rates and hours, exact per half hour (Irish local time,
as suppliers bill); an announced price change applied from its date; the
standing charge pro rata across it; the PSO levy; export paid at the plan's
rate. No cashback. The same method as docs/five-way-2026-10-09/truth.py,
reading the frozen plan list beside this file so the answers do not move when
prices do.
"""
import json, datetime as dt, os

HERE = os.path.dirname(os.path.abspath(__file__))
PLANS = {t['id']: t for t in json.load(open(os.path.join(HERE, 'tariffs-2026-10-09.json'))) if t.get('id') != '__meta__'}
TODAY = dt.date(2026, 10, 9)
PSO = 6.67

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
            (d0, h0), (d1, h1) = we['span']; at = dow * 24 + h; a = d0 * 24 + h0; c = d1 * 24 + h1
            if (a <= at < c) if a < c else (at >= a or at < c): base = we['rates'].get(b, base)
        elif dow in (we.get('days') or []) and (not we.get('window') or inwin(h, we['window'])):
            base = we['rates'].get(b, base)
    return b, base

def smart_plans():
    """The plans a smart-meter home can switch to, as the app ranks them (no dynamic, none withdrawn)."""
    return [i for i, p in PLANS.items() if not p.get('discontinued') and not p.get('on_hold') and p['type'] != 'dynamic' and p.get('meter', 'smart') == 'smart']

def cost(local_starts, imp, exp, pid, rural=False):
    """local_starts: naive local datetimes of each half hour's start, for one year of readings,
    priced as the year ahead (the same dates a year on)."""
    p = PLANS[pid]; pc = p.get('price_change')
    eff = dt.date.fromisoformat(pc['effective_date']) if pc and pc.get('effective_date') else None
    e = x = 0.0
    for t, i, o in zip(local_starts, imp, exp):
        b, r = rate(t, p)
        fut = (t + dt.timedelta(days=365)).date()
        if eff and eff > TODAY and fut >= eff: r *= 1 + (pc.get('pct_bands') or {}).get(b, pc.get('pct', 0) or 0)
        e += i * r; x += o * (p.get('export_rate') or 0)
    st = (p.get('standing_rural') or p['standing']) if rural else p['standing']
    if eff and eff > TODAY and (eff - TODAY).days < 365:
        st *= 1 + (pc.get('standing_pct') or 0) * (365 - (eff - TODAY).days) / 365
    # Export income above EUR 600 a year is taxed (Budget 2027), about 27% at the standard rate.
    tax = max(0.0, x - 600) * 0.27
    return e - x + tax + st + PSO

def all_costs(local_starts, imp, exp, rural=False):
    return {pid: round(cost(local_starts, imp, exp, pid, rural), 2) for pid in smart_plans()}
