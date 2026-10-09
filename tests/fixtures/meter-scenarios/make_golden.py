"""Write golden.json, the limits tests/e2e/golden-households.spec.js holds the app to.

    python3 tests/fixtures/meter-scenarios/make_golden.py <results dir>

For each reference scenario: where today's result is within the agreed tolerance
(use and bill 5%, payback half a year, best plan or one within EUR 25 a year),
the limit is that tolerance. Where it is not yet, the limit is today's error with
a small margin, marked as a known gap, so a change can only make it better. A fix
that closes a gap should run this again and commit the tighter limits.
"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REFERENCE = ['A1-gas', 'A2-heatpump', 'A7-ev', 'A3a-gas', 'A5b-heatpump', 'B2-gas_solar', 'B2-hp_solar_batt', 'B3-friend',
             'B4a-gas_solar', 'B5-hp_solar_gridfill', 'C1-gas_ev_now', 'D3b-gas', 'D3c-gas', 'D5e-gas']
TOL = dict(kwh=5.0, bill=5.0, plan=25, payback=0.5)

def limit(err, tol, step):
    if err is None: return tol
    e = abs(err)
    return tol if e <= tol else round(math.ceil((e * 1.05 + step) / step) * step, 2)

if __name__ == '__main__':
    rows = {r['id']: r for r in json.load(open(os.path.join(sys.argv[1], 'scores.json')))}
    out = {'note': __doc__.strip().split('\n\n')[1].replace('\n', ' '), 'scenarios': {}}
    for sid in REFERENCE:
        r = rows[sid]
        if r['outcome'] == 'rejected':
            out['scenarios'][sid] = {'rejected': True, 'why': 'must be turned away with a message'}; continue
        lim = dict(kwh=limit(r['kwh_err'], TOL['kwh'], 0.5), bill=limit(r['bill_err'], TOL['bill'], 0.5),
                   plan=limit(r['plan_gap'], TOL['plan'], 5), payback=limit(r.get('payback_err'), TOL['payback'], 0.1) if r.get('true_payback') else None)
        gaps = [k for k in ('kwh', 'bill', 'plan', 'payback') if lim[k] is not None and lim[k] > TOL[k]]
        if gaps: lim['known_gap'] = ', '.join(gaps)
        if r.get('asked'): lim['asks'] = 'filewhen'
        lim['today'] = dict(kwh_err=r['kwh_err'], bill_err=r['bill_err'], plan_gap=r['plan_gap'], payback=r.get('payback'), true_payback=r.get('true_payback'))
        out['scenarios'][sid] = lim
    json.dump(out, open(os.path.join(HERE, 'golden.json'), 'w'), indent=1)
    for k, v in out['scenarios'].items(): print(k, {x: v[x] for x in v if x != 'today'})
