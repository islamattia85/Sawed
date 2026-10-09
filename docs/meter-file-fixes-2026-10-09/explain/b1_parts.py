"""The B1 comparison: the friend's home in the coming year (panels up all year, exports paid
from day one), on every plan, with the reference battery and with one run as the app runs its
own (92% round trip, 10% kept back, held through the night hours); and the home's true use in
each B1 file's months."""
import sys, os, json, datetime as dt
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../tests/fixtures/meter-scenarios'))
import homes as H, price as P, build as B
import shift_test as T   # its battery with the app's habits
hs, _, _ = B.build_homes()
d = hs['friend']['use']; pv_d = H.pv_cork([(12 * 0.44, 225, 35), (10 * 0.44, 45, 35)], 23)
idx = [i for i in range(H.N) if B.in_year(i)]; loc = [H.LOCAL[i].replace(tzinfo=None) for i in idx]
sl = lambda s: [s[i] for i in idx]
i1, e1, _, _ = T.batt(d, pv_d, 9)
i2, e2, _, _ = T.batt(d, pv_d, 9, night_hold=True, eff_in=0.92 ** 0.5, eff_out=0.92 ** 0.5, floor=0.1)
out = dict(coming_year_reference=P.all_costs(loc, sl(i1), sl(e1)), coming_year_app_like=P.all_costs(loc, sl(i2), sl(e2)), file_year_use={})
SC = {s['id']: s for s in json.load(open(os.path.join(os.path.dirname(B.__file__), 'scenarios.json')))}
for sid in ('B1a-friend', 'B1b-friend', 'B1c-friend', 'B1d-friend'):
    a, b = (dt.date.fromisoformat(x) for x in SC[sid]['window'])
    out['file_year_use'][sid] = dict(window=SC[sid]['window'], use=round(sum(v for i, v in enumerate(d) if a <= H.LOCAL[i].date() <= b)), days=(b - a).days + 1)
# Figures for the battery-home explanation: the true heat pump home's night share and its
# no-panels cost on two plans; what the battery home's battery really lost in the year.
hp = hs['heatpump']['use']
night = lambda i: H.LOCAL[i].hour >= 23 or H.LOCAL[i].hour < 8
out['heatpump_night_share_pct'] = round(sum(hp[i] for i in idx if night(i)) / sum(hp[i] for i in idx) * 100, 1)
c = P.all_costs(loc, sl(hp), [0.0] * len(idx))
out['heatpump_no_solar_cost'] = {k: c[k] for k in ('EI-SST', 'EN-SMART-24-HOUR')}
u, g = hs['hp_solar_batt']['use'], hs['hp_solar_batt']['gen']; soc = ch = 0.0
for i in range(H.N):
    net = u[i] - g[i]
    if net < 0: x = min(-net, (10 - soc) / 0.95, 1.5); soc += x * 0.95; ch += x * B.in_year(i)
    else: soc -= min(net, soc, 1.5)
out['hp_solar_batt_battery'] = dict(charged=round(ch), lost=round(ch * 0.05))
json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'b1_parts.json'), 'w'), indent=1)
print({k: ({p: v[p] for p in ('EI-SST', 'PIN-FAM', 'EI-NB')} if k.startswith('coming') else v) for k, v in out.items()})
