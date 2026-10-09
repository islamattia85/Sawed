"""Turn a real home's files into a scenario the app can be scored on.

    python3 tests/fixtures/meter-scenarios/real/add_home.py <home folder>
    python3 tests/fixtures/meter-scenarios/real/add_home.py --selftest

The home folder (under real/private/, which git ignores) holds home.json (see
home.example.json), the ESB meter file and, if there is one, the Sigenergy
export. This writes, all inside real/private/:

  files/<id>.csv.gz   the meter file with its MPRN and meter serial replaced
  truth.json          the home's true figures, keyed real_<id>
  scenarios.json      the scenario R-<id>: upload the file, answer as home.json says

What the truth is made of:
  bills on every plan  the meter file's last twelve months, priced half hour by
                       half hour as the coming year (the same method as the
                       made-up homes: price.py, the frozen plan list)
  the home's own use   the Sigenergy file's home-use column over those months
  the solar saving     the cheapest plan for the home's own use (no panels)
                       less the cheapest for what the meter bought and sold;
                       the payback, the price after grant over that

Without a Sigenergy file the bills and the best plan are still exact; the use
and the payback are left out and not scored.
"""
import json, os, sys, datetime as dt
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import esb as E, sigenergy as S
import price as P

PRIVATE = os.path.join(HERE, 'private')


def build(folder):
    home = json.load(open(os.path.join(folder, 'home.json')))
    hid = home['id']
    src = os.path.join(folder, home['esb'])
    dst = os.path.join(PRIVATE, 'files', f'{hid}.csv.gz')
    rows = E.anonymise(src, dst)
    readings = E.read_esb(dst)
    last = readings[-1][1].date()
    first_day = last - dt.timedelta(days=364)
    year = [r for r in readings if first_day <= r[1].date() <= last]
    loc = [r[1] for r in year]; imp = [r[2] for r in year]; exp = [r[3] for r in year]
    rural = bool(home.get('rural'))
    costs = P.all_costs(loc, imp, exp, rural)
    best = min(costs, key=costs.get)
    t = dict(label=home.get('title', hid), year=[str(first_day), str(last)], bought_kwh=round(sum(imp)), sold_kwh=round(sum(exp)),
             costs=costs, best=best, best_cost=costs[best], use_kwh=None, real=True)
    report = dict(home=hid, meter_rows=rows, half_hours=len(readings), truth_year=t['year'], days_in_year=len({x.date() for x in loc}))
    sys_ = home.get('system')
    if home.get('sigenergy'):
        sig = S.read_sigenergy(os.path.join(folder, home['sigenergy']))
        hh, align = S.to_half_hours(sig, readings)
        report.update(sigenergy_columns=sig['found'], sigenergy_minutes=sig['minutes'], sigenergy_units=sig['unit'], **align)
        keyed = {r[0]: r for r in year}
        have = [u for u in keyed if u in hh]
        report['sigenergy_half_hours_in_year'] = len(have)
        g = lambda q: sum(hh[u].get(q, 0.0) for u in have)
        # Checks that the two files describe the same home at the same times.
        if 'imp' in sig['found']: report['bought: sigenergy vs meter'] = [round(g('imp')), round(sum(keyed[u][2] for u in have))]
        if 'exp' in sig['found']: report['sold: sigenergy vs meter'] = [round(g('exp')), round(sum(keyed[u][3] for u in have))]
        if len(have) < 0.9 * len(year):
            raise SystemExit(f'The Sigenergy file covers {len(have)} of the {len(year)} half hours in the meter file\'s last year: export the same twelve months.')
        if 'load' in sig['found']:
            load = [hh[u].get('load', 0.0) if u in hh else 0.0 for u in (r[0] for r in year)]
        else:   # home use = bought + made - sold, with what the battery stored and gave back
            load = [keyed[u][2] + hh.get(u, {}).get('gen', 0.0) - keyed[u][3] - hh.get(u, {}).get('bch', 0.0) + hh.get(u, {}).get('bdis', 0.0) for u in (r[0] for r in year)]
            report['use worked out as'] = 'bought + generation - sold - battery charge + battery discharge'
        t['use_kwh'] = round(sum(load)); t['gen_kwh'] = round(g('gen'))
        if sys_ and sys_.get('cost'):
            nos = P.all_costs(loc, load, [0.0] * len(load), rural)
            saving = min(nos.values()) - costs[best]
            t['saving'] = round(saving, 2); t['best_without_solar'] = min(nos, key=nos.get); t['best_with_solar'] = best
            t['payback'] = round((sys_['cost'] - sys_.get('grant', 0)) / saving, 2) if saving > 0 else None
    if sys_: t['system'] = sys_
    sc = dict(id=f'R-{hid}', group='R', title=home.get('title', hid), home=hid, truth=f'real_{hid}', file=f'real/private/files/{hid}.csv',
              answers=home.get('answers', {}), window=t['year'], real=True)
    if sys_: sc['system'] = dict(faces=sys_['faces'], panel_w=sys_['panel_w'], battery=sys_.get('battery', 0), cost=sys_.get('cost', 0), grant=sys_.get('grant', 0))
    for name, key, val in (('truth.json', f'real_{hid}', t), ('scenarios.json', None, sc)):
        p = os.path.join(PRIVATE, name)
        cur = json.load(open(p)) if os.path.exists(p) else ({} if key else [])
        if key: cur[key] = val
        else: cur = [x for x in cur if x['id'] != sc['id']] + [sc]
        json.dump(cur, open(p, 'w'), indent=1)
    return report


def selftest(keep=False):
    """Run the whole path on a made-up home: the tester's case rebuilt (truth.json 'friend'), with a
    Sigenergy-style export made from its own half hours, so a change here is checked without real data."""
    import gzip, tempfile, csv
    sys.path.insert(0, os.path.dirname(HERE))
    import homes as H, build as B
    hs, _, _ = B.build_homes(); h = hs['friend']
    d = tempfile.mkdtemp(prefix='peakless-real-')
    text = B.esb_text(h['imp'], h['exp'], dt.date(2025, 10, 9), dt.date(2026, 10, 8))
    open(os.path.join(d, 'esb.csv'), 'w').write(text.replace(B.MPRN, '10012345678'))
    with open(os.path.join(d, 'sigen.csv'), 'w', newline='') as f:   # five-minute power rows, stamped at the end, as some exports are
        w = csv.writer(f); w.writerow(['Time', 'PV Power(kW)', 'Load Power(kW)', 'Grid Import Power(kW)', 'Grid Export Power(kW)'])
        for i, u in enumerate(H.SLOTS):
            if not (dt.date(2025, 10, 9) <= H.LOCAL[i].date() <= dt.date(2026, 10, 8)): continue
            for k in range(6):
                end = (u + dt.timedelta(minutes=5 * (k + 1))).astimezone(H.TZ)
                w.writerow([end.strftime('%Y-%m-%d %H:%M:%S'), round(h['gen'][i] * 2, 4), round(h['use'][i] * 2, 4), round(h['imp'][i] * 2, 4), round(h['exp'][i] * 2, 4)])
    s = h['system']
    json.dump(dict(id='selftest', title='Self-test: the tester\'s case rebuilt', esb='esb.csv', sigenergy='sigen.csv',
                   answers=dict(heat='heatpump', solar='have', panels=22, battery=9, gridnow='no', filewhen=['allyear', 'noexport', 'before']),
                   system=dict(faces=s['faces'], panel_w=s['panel_w'], battery=s['battery'], cost=s['cost'], grant=s['grant'], installed='2025-10-20')),
              open(os.path.join(d, 'home.json'), 'w'))
    global PRIVATE
    real_private = PRIVATE
    if not keep: PRIVATE = os.path.join(d, 'out')   # --keep: into real/private/, to run R-selftest through the app
    try:
        rep = build(d)
        t = json.load(open(os.path.join(PRIVATE, 'truth.json')))['real_selftest']
        want = json.load(open(os.path.join(os.path.dirname(HERE), 'truth.json')))['friend']
        assert gzip.open(os.path.join(PRIVATE, 'files', 'selftest.csv.gz'), 'rt').read().count('10012345678') == 0, 'MPRN left in the file'
        assert rep['stamped'] == 'end of interval' and rep['match'] > 0.99, rep
        assert abs(t['use_kwh'] - want['use_kwh']) <= 2, (t['use_kwh'], want['use_kwh'])
        assert abs(t['best_cost'] - want['best_cost']) < 1 and t['best'] == want['best'], (t['best'], t['best_cost'], want['best'], want['best_cost'])
        assert abs(t['payback'] - want['payback']) < 0.05, (t['payback'], want['payback'])
        print('selftest passed:', json.dumps(rep, default=str))
        print('truth:', {k: t[k] for k in ('use_kwh', 'bought_kwh', 'sold_kwh', 'gen_kwh', 'best', 'best_cost', 'saving', 'payback')})
    finally:
        PRIVATE = real_private


if __name__ == '__main__':
    if sys.argv[1:2] == ['--selftest']: selftest(keep='--keep' in sys.argv)
    else: print(json.dumps(build(sys.argv[1]), indent=1, default=str))
