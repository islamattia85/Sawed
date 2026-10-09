"""Truth-side components for the B1 and saving-bias explanations."""
import sys, json, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../tests/fixtures/meter-scenarios'))
import homes as H, price as P, build as B
hs, pv_plan, PLAN = B.build_homes()
idx = [i for i in range(H.N) if B.in_year(i)]
loc = [H.LOCAL[i].replace(tzinfo=None) for i in idx]
sl = lambda s: [s[i] for i in idx]
out = {}
def parts(imp, exp):
    c = P.all_costs(loc, sl(imp), sl(exp)); b = min(c, key=c.get); return b, round(c[b], 1), c
# Planning homes: the 4 kWp south system, no battery
for k in ('gas', 'heatpump', 'ev'):
    h = hs[k]; use = h['use']
    si, se = H.battery(use, pv_plan, 0)
    nb, nc, _ = parts(use, [0.0] * H.N); wb, wc, wcs = parts(si, se)
    out[k] = dict(use=round(sum(sl(use))), gen=round(sum(sl(pv_plan))), bought=round(sum(sl(si))), sold=round(sum(sl(se))),
                  self_use=round(sum(sl(pv_plan)) - sum(sl(se))), no_solar=[nb, nc], with_solar=[wb, wc], saving=round(nc - wc, 1),
                  with_on_EI_SST=round(wcs['EI-SST'], 1))
# Battery homes: the no-solar side and the with-solar side as recorded
for k in ('gas_solar', 'hp_solar_batt', 'hp_solar_gridfill', 'friend'):
    h = hs[k]; use = h['use']
    nb, nc, ncs = parts(use, [0.0] * H.N); wb, wc, wcs = parts(h['imp'], h['exp'])
    out[k] = dict(use=round(sum(sl(use))), gen=round(sum(sl(h['gen']))), bought=round(sum(sl(h['imp']))), sold=round(sum(sl(h['exp']))),
                  no_solar=[nb, nc], with_solar=[wb, wc], saving=round(nc - wc, 1), with_on_EI_SST=round(wcs['EI-SST'], 1))
# The friend's home in the coming year: panels up all year, exports paid from day one.
d = hs['friend']['use']
pv_d = H.pv_cork([(12 * 0.44, 225, 35), (10 * 0.44, 45, 35)], 23)
i2, e2, g2 = B.with_system(d, pv_d, 9, None)
wb, wc, wcs = parts(i2, e2)
out['friend_full_year'] = dict(gen=round(sum(sl(g2))), bought=round(sum(sl(i2))), sold=round(sum(sl(e2))), with_solar=[wb, wc], on_EI_SST=round(wcs['EI-SST'], 1))
# Same, with a 90% round-trip battery (5% lost each way) instead of the idealised 95% round trip
def battery90(use, gen, cap, eff_in=0.95, eff_out=0.95, rate=1.5):
    imp, exp = [0.0] * H.N, [0.0] * H.N; soc = 0.0
    for i in range(H.N):
        net = use[i] - gen[i]
        if net < 0: c = min(-net, (cap - soc) / eff_in, rate); soc += c * eff_in; exp[i] = -net - c
        else: dch = min(net, soc * eff_out, rate); soc -= dch / eff_out; imp[i] = net - dch
    return imp, exp
i3, e3 = battery90(d, pv_d, 9)
wb3, wc3, wcs3 = parts(i3, e3)
out['friend_full_year_90rt'] = dict(bought=round(sum(sl(i3))), sold=round(sum(sl(e3))), with_solar=[wb3, wc3], on_EI_SST=round(wcs3['EI-SST'], 1))
# Hourly instead of half-hourly netting (the app simulates hours): gas home with the planned panels
def hourly(s): return [s[i] + s[i + 1] if i % 2 == 0 else 0.0 for i in range(len(s))]
for k in ('gas', 'heatpump'):
    u = hourly(hs[k]['use']); g = hourly(pv_plan)
    si, se = H.battery(u, g, 0)
    wb, wc, _ = parts(si, se); out[k]['hourly_netting'] = dict(sold=round(sum(sl(se))), with_solar=[wb, wc])
json.dump(out, open(os.path.join(os.path.dirname(__file__), 'truth_parts.json'), 'w'), indent=1)
for k, v in out.items(): print(k, v)
