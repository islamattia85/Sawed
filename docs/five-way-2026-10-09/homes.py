"""Thirteen synthetic Irish homes, a year of half-hours each (import and export kWh)."""
import openpyxl, datetime as dt, json, math, random
wb = openpyxl.load_workbook('/tmp/claude-0/-home-user-Sawed/74c17acb-5048-514f-a9cb-512d72f36e1c/scratchpad/slp/legacy.xlsx', read_only=True, data_only=True)
def qh(name):
    out = {}
    for r in wb[name].iter_rows(min_row=6, max_row=370, values_only=True):
        if r[1] and not (r[1].month == 2 and r[1].day == 29): out[r[1].date()] = [x or 0 for x in r[2:98]]
    return out
L1, L2, L3 = qh('LP1'), qh('LP2'), qh('LP3')
END = dt.datetime(2026, 10, 9)
def days():
    d0 = END - dt.timedelta(days=365)
    return [d0 + dt.timedelta(days=i) for i in range(365)]
def prof_day(prof, d):
    k = dt.date(2026, d.month, d.day)
    v = prof[k]; return [v[2*i] + v[2*i+1] for i in range(48)]
DD = [16, 14, 13, 9, 5, 1, 0, 0, 2, 7, 13, 16]   # heating share by month (%), Irish degree days
def base(prof, kwh, seed):
    rnd = random.Random(seed); tot = sum(sum(prof_day(prof, d)) for d in days()); out = []
    for d in days():
        f = rnd.uniform(0.8, 1.2)
        out.append([x / tot * kwh * f * rnd.uniform(0.9, 1.1) for x in prof_day(prof, d)])
    return out
def scale(a, kwh):
    s = sum(map(sum, a)); return [[x * kwh / s for x in r] for r in a]
def add_heating(a, kwh, hours, seed):
    rnd = random.Random(seed)
    for i, d in enumerate(days()):
        day = kwh * DD[d.month - 1] / 100 / 30.4 * rnd.uniform(0.7, 1.3)
        for h, w in hours.items():
            for s in (2*h, 2*h+1): a[i][s] += day * w / sum(hours.values()) / 2
    return a
def add_block(a, kwh, h0, h1, weekdays_only=False):
    per = kwh / 365 / ((h1 - h0) * 2)
    for i, d in enumerate(days()):
        if weekdays_only and d.weekday() >= 5: continue
        for s in range(2*h0, 2*h1): a[i][s] += per * (7/5 if weekdays_only else 1)
    return a
def pv(kwp, seed):
    rnd = random.Random(seed); yld = [0.9, 1.6, 2.6, 3.7, 4.3, 4.4, 4.1, 3.5, 2.8, 1.8, 1.1, 0.7]   # kWh/kWp/day, Ireland
    rise = [8.5, 8, 7, 6, 5.3, 5, 5.2, 6, 7, 7.8, 8, 8.7]; sets = [16.5, 17.5, 19, 20.3, 21.2, 21.8, 21.6, 20.6, 19.4, 18.2, 16.6, 16.2]
    out = []
    for d in days():
        m = d.month - 1; tot = kwp * yld[m] * rnd.uniform(0.35, 1.6); r, s = rise[m], sets[m]
        w = [max(0, math.sin(math.pi * ((i/2 + 0.25) - r) / (s - r))) if r <= i/2 + 0.25 <= s else 0 for i in range(48)]
        sw = sum(w) or 1; out.append([tot * x / sw for x in w])
    return out
def solar(load, gen, batt=0):
    imp, exp = [], []
    soc = 0
    for L, G in zip(load, gen):
        ri, re_ = [], []
        for l, g in zip(L, G):
            net = l - g
            if net < 0:
                c = min(-net, batt - soc, 1.5); soc += c * 0.95; re_.append(-net - c); ri.append(0)
            else:
                dch = min(net, soc, 1.5); soc -= dch; ri.append(net - dch); re_.append(0)
        imp.append(ri); exp.append(re_)
    return imp, exp
H = {}
H['small'] = (base(L1, 2000, 1), None, 'Small flat, 2,000 kWh')
H['typical'] = (base(L1, 4200, 2), None, 'Typical home, 4,200 kWh')
H['large'] = (base(L1, 7500, 3), None, 'Large family, 7,500 kWh')
w = base(L1, 4200, 4); w = add_block(w, 900, 9, 17, weekdays_only=True); H['wfh'] = (w, None, 'Two working from home, 5,100 kWh')
H['night'] = (scale(base(L2, 5000, 5), 5000), None, 'Night-heavy (immersion on a night timer), 5,000 kWh')
hp = add_heating(base(L1, 3500, 6), 5500, {6: 2, 7: 2, 8: 1.5, 9: 1, 10: 1, 11: 1, 12: 1, 13: 1, 14: 1, 15: 1, 16: 1.5, 17: 2, 18: 2, 19: 2, 20: 1.5, 21: 1.5, 22: 1, 23: .6, 0: .6, 1: .6, 2: .6, 3: .6, 4: .6, 5: 1}, 7)
H['heatpump'] = (hp, None, 'Heat pump, 9,000 kWh')
st = add_heating(base(L1, 3000, 8), 8000, {23: 1, 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1}, 9); H['storage'] = (st, None, 'Night storage heaters, 11,000 kWh')
H['ev_night'] = (add_block(base(L1, 4200, 10), 2500, 2, 5), None, 'EV charged 2am-5am, 6,700 kWh')
H['ev_evening'] = (add_block(base(L1, 4200, 11), 2500, 18, 21), None, 'EV charged at teatime, 6,700 kWh')
load = base(L1, 4200, 12); g = pv(4.0, 13); i1, e1 = solar(load, g); H['solar'] = (i1, e1, '4 kWp solar, no battery')
i2, e2 = solar(load, g, 10); H['solar_batt'] = (i2, e2, '4 kWp solar + 10 kWh battery')
H['rural'] = (base(L3, 4200, 14), None, 'Rural typical home, 4,200 kWh')
H['legacy24'] = (base(L1, 4200, 15), None, 'Typical home, older 24-hour meter')
# Panels and a battery put in partway through the year: the file is part before, part after.
inst = END.date() - dt.timedelta(days=177)   # mid-April
lm = base(L1, 5500, 16); gm = pv(6.0, 17); im, em = solar(lm, gm, 9)
mid_i = [L if d.date() < inst else I for d, L, I in zip(days(), lm, im)]
mid_e = [[0]*48 if d.date() < inst else E for d, E in zip(days(), em)]
H['solar_mid'] = (mid_i, mid_e, '6 kWp + 9 kWh battery, put in mid-April (file part before, part after)')
# The year ahead has the panels all year: that is what the true cost is worked out on.
json.dump([((d + dt.timedelta(minutes=30*k)).isoformat(), I[k], E[k]) for d, I, E in zip(days(), im, em) for k in range(48)], open('solar_mid_ahead.json', 'w'))
# A big system and a car charged at night.
le = add_block(base(L1, 4200, 18), 2500, 2, 5); ge = pv(6.0, 19); ie, ee = solar(le, ge, 10)
H['solar_ev'] = (ie, ee, '6 kWp + 10 kWh battery + EV charged 2am-5am')
meta = {}
for k, (imp, exp, label) in H.items():
    rows = ['MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time']; hh = []
    for d, r, re_ in zip(days(), imp, exp or [[0]*48]*365):
        for s in range(48):
            t = d + dt.timedelta(minutes=30*s); hh.append((t.isoformat(), r[s], re_[s]))
    for t, a, b in reversed(hh):
        end = dt.datetime.fromisoformat(t) + dt.timedelta(minutes=30)
        rows.append(f"10306268587,34201234,{a*2:.3f},Active Import Interval (kW),{end.strftime('%d-%m-%Y %H:%M')}")
        if exp: rows.append(f"10306268587,34201234,{b*2:.3f},Active Export Interval (kW),{end.strftime('%d-%m-%Y %H:%M')}")
    open(f'{k}.csv', 'w').write('\n'.join(rows) + '\n'); json.dump(hh, open(f'{k}.json', 'w'))
    meta[k] = {'label': label, 'import': round(sum(a for _, a, _ in hh)), 'export': round(sum(b for *_, b in hh))}
    print(k, meta[k])
json.dump(meta, open('meta.json', 'w'), indent=1)
