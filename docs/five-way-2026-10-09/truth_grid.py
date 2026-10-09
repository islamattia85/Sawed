"""Battery homes, second truth: what each plan costs if the battery is also filled
from the grid in the plan's cheapest hours, as Peakless and kilowatt.ie assume.
Same household, panels and battery as homes.py (charge/discharge 1.5 kWh per
half hour, 95% in). Each month the fill level (0-100%) that is cheapest for that
plan is used: a fixed schedule set once a month, chosen with hindsight, so this
is the best a home could do on that plan, not what it will do. A fill level of
0 is the home as it runs today (panels only), so this is never dearer than the first truth."""
import json, datetime as dt
import truth as tr
src = open('homes.py').read().split('H = {}')[0]; ns = {}; exec(src, ns)
base, add_block, pv, days, L1 = ns['base'], ns['add_block'], ns['pv'], ns['days'], ns['L1']
HOMES = {'solar_batt': (base(L1, 4200, 12), pv(4.0, 13), 10),
         'solar_mid': (base(L1, 5500, 16), pv(6.0, 17), 9),
         'solar_ev': (add_block(base(L1, 4200, 18), 2500, 2, 5), pv(6.0, 19), 10)}
START = tr.START
def series(pid):
    p = tr.P[pid]; pc = p.get('price_change'); eff = dt.date.fromisoformat(pc['effective_date']) if pc and pc.get('effective_date') else None
    R = []
    for d in days():
        for s in range(48):
            t = d + dt.timedelta(minutes=30*s); fut = (t + dt.timedelta(days=365)).date()
            b, r = tr.rate(t, p)
            if eff and fut >= eff and eff > START: r *= 1 + (pc.get('pct_bands') or {}).get(b, pc.get('pct', 0) or 0)
            R.append(r)
    return R
def run(load, gen, cap, R, xr, lo, hi, soc, target):
    cost = 0.0
    for k in range(lo, hi):
        i, s = divmod(k, 48); l, g = load[i][s], gen[i][s]
        day = R[i*48:(i+1)*48]; cheap = min(day) < max(day) - 1e-9 and R[k] <= min(day) + 1e-9
        net = l - g; imp = exp = 0.0
        if net < 0:
            c = min(-net, cap - soc, 1.5); soc += c * 0.95; exp = -net - c
        else:
            if cheap and target > 0: imp = net   # filling from the grid: the battery waits
            else: dch = min(net, soc, 1.5); soc -= dch; imp = net - dch
        if cheap and soc < target * cap:
            c = min(1.5 - 0, (target * cap - soc) / 0.95); soc += c * 0.95; imp += c
        cost += imp * R[k] - exp * xr
    return cost, soc
if __name__ == '__main__':
    T = json.load(open('truth.json')); G = {}
    D = days(); bounds = [0]
    for i in range(1, len(D)):
        if D[i].month != D[i-1].month: bounds.append(i*48)
    bounds.append(len(D)*48)
    for h, (load, gen, cap) in HOMES.items():
        G[h] = {}
        for pid in T[h]:
            p = tr.P[pid]; R = series(pid); xr = p.get('export_rate') or 0
            soc = 0.0; tot = 0.0; plan = []
            for a, b in zip(bounds, bounds[1:]):
                best = min((run(load, gen, cap, R, xr, a, b, soc, t) + (t,) for t in (0, .25, .5, .75, 1)), key=lambda x: x[0])
                tot += best[0]; soc = best[1]; plan.append(best[2])
            st = (p.get('standing_rural') or p['standing']) if False else p['standing']
            pc = p.get('price_change'); eff = dt.date.fromisoformat(pc['effective_date']) if pc and pc.get('effective_date') else None
            if eff and eff > START and (eff - START).days < 365: st *= 1 + (pc.get('standing_pct') or 0) * (365 - (eff - START).days) / 365
            G[h][pid] = round(tot + st + 6.67, 2)
        b = min(G[h], key=G[h].get); a = min(T[h], key=T[h].get)
        print(h, 'grid-filled best', b, G[h][b], '| as run best', a, T[h][a], '| YN-EV-DNP', G[h].get('YN-EV-DNP'), T[h].get('YN-EV-DNP'), '| EI-NB', G[h].get('EI-NB'), T[h].get('EI-NB'))
    json.dump(G, open('truth_grid.json', 'w'))
