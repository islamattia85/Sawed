"""Run the truth homes with the app's two habits, one at a time, to size each:
(1) solar placed on Irish winter time all year (an hour early in summer against the clock the meter keeps);
(2) panels making 1.9% less (the app's 3,841 kWh against 3,914 for the 4 kWp south system);
(3) for the battery home: no discharge in the night hours 23:00-08:00 (the app keeps the battery for the day)."""
import sys, json, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../tests/fixtures/meter-scenarios'))
import homes as H, price as P, build as B
hs, pv_plan, PLAN = B.build_homes()
idx = [i for i in range(H.N) if B.in_year(i)]
loc = [H.LOCAL[i].replace(tzinfo=None) for i in idx]
sl = lambda s: [s[i] for i in idx]
def best(imp, exp):
    c = P.all_costs(loc, sl(imp), sl(exp)); b = min(c, key=c.get); return b, round(c[b], 1), c
def ist(i): return H.LOCAL[i].utcoffset().total_seconds() > 0
def early(pv):  # on the meter's clock, an hour early whenever summer time is on
    return [pv[i + 2] if ist(i) and i + 2 < H.N else pv[i] for i in range(H.N)]
def batt(use, gen, cap, night_hold=False, eff_in=0.95, eff_out=1.0, rate=1.5, floor=0.0):
    imp, exp = [0.0] * H.N, [0.0] * H.N; soc = 0.0; ch = dis = 0.0
    for i in range(H.N):
        net = use[i] - gen[i]; hr = H.LOCAL[i].hour
        if net < 0:
            c = min(-net, (cap - soc) / eff_in, rate); soc += c * eff_in; exp[i] = -net - c; ch += c * (B.in_year(i))
        elif night_hold and (hr >= 23 or hr < 8):
            imp[i] = net
        else:
            x = min(net, max(0, soc - floor * cap) * eff_out, rate); soc -= x / eff_out; imp[i] = net - x; dis += x * (B.in_year(i))
    return imp, exp, round(ch), round(dis)
def main():
  out = {}
  for k in ('gas', 'heatpump', 'ev'):
      use = hs[k]['use']; nb, nc, _ = best(use, [0.0] * H.N); r = {'no_solar': nc}
      for name, pv in (('truth', pv_plan), ('summer_hour_early', early(pv_plan)), ('gen_minus_1.9pct', [v * 3841 / 3914 for v in pv_plan]),
                       ('both', [v * 3841 / 3914 for v in early(pv_plan)])):
          si, se = H.battery(use, pv, 0); wb, wc, _ = best(si, se)
          r[name] = dict(plan=wb, with_solar=wc, saving=round(nc - wc, 1), bought=round(sum(sl(si))), sold=round(sum(sl(se))), self_use=round(sum(sl(pv)) - sum(sl(se))))
      out[k] = r
  # The friend's battery, panels up all year: the truth battery against one kept full through the night hours
  d = hs['friend']['use']; pv_d = H.pv_cork([(12 * 0.44, 225, 35), (10 * 0.44, 45, 35)], 23)
  for name, kw in (('truth_battery', {}), ('held_through_night', dict(night_hold=True)),
                   ('held_through_night_92rt_10pct_floor', dict(night_hold=True, eff_in=0.92 ** 0.5, eff_out=0.92 ** 0.5, floor=0.1))):
      i2, e2, ch, dis = batt(d, pv_d, 9, **kw); wb, wc, c = best(i2, e2)
      nightimp = round(sum(i2[i] for i in idx if H.LOCAL[i].hour >= 23 or H.LOCAL[i].hour < 8))
      out['friend_' + name] = dict(on_EI_SST=round(c['EI-SST'], 1), bought=round(sum(sl(i2))), sold=round(sum(sl(e2))), charged=ch, delivered=dis, night_bought=nightimp)
  json.dump(out, open(os.path.join(os.path.dirname(__file__), 'shift_test.json'), 'w'), indent=1)
  for k, v in out.items(): print(k, v)

if __name__ == '__main__':
    main()
