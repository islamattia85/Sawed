"""The two solar homes' meter files from before their panels: same household, same
seeds as homes.py, nothing generated or exported. For the 'planning solar' test."""
import json, datetime as dt
src = open('homes.py').read().split('H = {}')[0]
ns = {}; exec(src, ns)
base, add_block, days, L1 = ns['base'], ns['add_block'], ns['days'], ns['L1']
P = {'solar_pre': base(L1, 4200, 12), 'solar_ev_pre': add_block(base(L1, 4200, 18), 2500, 2, 5)}
for k, imp in P.items():
    rows = ['MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time']; hh = []
    for d, r in zip(days(), imp):
        for s in range(48): hh.append(((d + dt.timedelta(minutes=30*s)).isoformat(), r[s], 0))
    for t, a, _ in reversed(hh):
        end = dt.datetime.fromisoformat(t) + dt.timedelta(minutes=30)
        rows.append(f"10306268587,34201234,{a*2:.3f},Active Import Interval (kW),{end.strftime('%d-%m-%Y %H:%M')}")
    open(f'{k}.csv', 'w').write('\n'.join(rows) + '\n'); json.dump(hh, open(f'{k}.json', 'w'))
    print(k, round(sum(a for _, a, _ in hh)))
