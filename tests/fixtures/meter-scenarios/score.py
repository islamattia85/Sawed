"""Score the scenario runs against the true values.

    python3 tests/fixtures/meter-scenarios/score.py <results dir>

Writes <results dir>/scores.json and prints one line per scenario.

Tolerances (the brief's): consumption within 5%, bill within 5%, payback
within 0.5 years, and the same best plan or one within EUR 25 a year. For a
partial or short file (A3-A5) the seasons are a guess, so the brief asks what
error is acceptable: we use 10% for nine months and 15% for a few weeks, and
say so in the report.

Where the truth prices each plan with the battery set for it (battery_per_plan),
the plan the home is on is held to the bill tolerance too ("current plan").

Two checks besides the figures. A file the app reads less than 95% of must say
so on the import card (data-warn="unread"): readings dropped without a word
fail ("lost readings, no warning"). And whether the accuracy figure the app
shows covers the error found (acc_covers) is recorded for every result.
"""
import gzip, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TRUTH = json.load(open(os.path.join(HERE, 'truth.json')))
SC = {s['id']: s for s in json.load(open(os.path.join(HERE, 'scenarios.json')))}
# Real homes (real/private/, kept out of git), when they are there. Their use is
# known only with a Sigenergy file; without one it is not scored.
_REAL = os.path.join(HERE, 'real', 'private')
if os.path.exists(os.path.join(_REAL, 'truth.json')):
    TRUTH.update(json.load(open(os.path.join(_REAL, 'truth.json'))))
    SC.update({s['id']: s for s in json.load(open(os.path.join(_REAL, 'scenarios.json')))})

_ROWS = {}
def file_readings(name):
    """Import readings in a scenario file: distinct half-hours (a repeated row counts once), and all rows."""
    if name not in _ROWS:
        seen, n = set(), 0
        with gzip.open(os.path.join(HERE, name + '.gz') if name.startswith('real/') else os.path.join(HERE, 'files', name + '.gz'), 'rt', errors='replace') as f:
            for line in f:
                c = line.rstrip('\n').split(',')
                if len(c) >= 5 and 'import' in c[3].lower(): seen.add((c[1], c[4], c[2])); n += 1
        _ROWS[name] = (len({k[:2] for k in seen}), n, len(seen))
    return _ROWS[name]

def tolerance(sid):
    if sid.startswith(('A5',)): return dict(kwh=15, bill=15, payback=1.0, plan=25)
    if sid.startswith(('A3', 'A4')): return dict(kwh=10, bill=10, payback=0.75, plan=25)
    return dict(kwh=5, bill=5, payback=0.5, plan=25)

def score(r):
    sc = SC[r['id']]; t = TRUTH[sc['truth']]; tol = tolerance(r['id'])
    out = dict(id=r['id'], group=sc['group'], title=sc['title'], home=sc['home'], truth_home=sc['truth'])
    if r.get('seen', {}).get('rejected') or 'kwh' not in r:
        out.update(outcome='rejected', message=(r.get('seen', {}).get('rejected') or '')[:300]); return out
    asked = [q for q in r['seen']['questions'] if q['q'] in ('filewhen',)]
    out['asked'] = [q['text'] for q in asked]
    out['kwh'] = r['kwh']; out['true_kwh'] = t['use_kwh']
    out['kwh_err'] = round((r['kwh'] - t['use_kwh']) / t['use_kwh'] * 100, 1) if t['use_kwh'] else None
    # A home planning solar is priced as it is today (the app ranks plans with the planned panels in).
    ranked = r.get('today') or r['ranked']
    # A battery that only stores solar (every battery home here but the one filled at night): the
    # app leads with a plan that needs night filling and gives the solar-only answer under it.
    # The answer for how this battery runs is the one scored; the headline is kept beside it.
    out['headline'] = dict(best=ranked[0]['id'], bill=ranked[0]['net'], gap=round(t['costs'][ranked[0]['id']] - t['best_cost']) if ranked[0]['id'] in t['costs'] else None)
    if r.get('solarOnly') and sc['truth'] != 'hp_solar_gridfill' and not t.get('battery_per_plan'):
        ranked = r['solarOnly']; out['scored_on'] = 'solar-only answer'
    best = ranked[0]['id']; best_net = ranked[0]['net']; costs = t['costs']
    out['best'] = best; out['true_best'] = t['best']
    out['plan_gap'] = round(costs[best] - t['best_cost']) if best in costs else None
    out['bill'] = best_net; out['true_bill_same_plan'] = round(costs[best]) if best in costs else None
    out['bill_err'] = round((best_net - costs[best]) / costs[best] * 100, 1) if best in costs else None
    # How far every plan's figure is from its true cost (the price gap, as in the five-way study).
    gaps = [abs(x['net'] - costs[x['id']]) / max(200, costs[x['id']]) * 100 for x in ranked if x['id'] in costs]
    out['price_gap'] = round(sum(gaps) / len(gaps), 1) if gaps else None
    if t.get('payback') and not r.get('solar'):
        out['payback'] = None; out['true_payback'] = t['payback']; out['payback_err'] = None
    if r.get('solar') and t.get('payback'):
        out['saving'] = round(r['solar']['saving']); out['true_saving'] = round(t['saving'])
        out['saving_err'] = round((r['solar']['saving'] - t['saving']) / t['saving'] * 100, 1)
        out['payback'] = round(r['solar']['payback'], 1) if r['solar']['payback'] < 900 else None
        out['true_payback'] = t['payback']
        out['payback_err'] = round(out['payback'] - t['payback'], 1) if out['payback'] is not None else None
    # The plan the home is on, where the truth prices every plan with the battery set for it:
    # the figure the app shows for it must rest on the same setting (fixed 10 Oct 2026).
    cur = sc['answers'].get('plan')
    if t.get('battery_per_plan') and cur in costs:
        mine = next((x['net'] for x in r['ranked'] if x['id'] == cur), None)
        out['current'] = cur; out['current_bill'] = mine; out['true_current'] = round(costs[cur])
        out['current_err'] = round((mine - costs[cur]) / costs[cur] * 100, 1) if mine is not None else None
    out['accuracy_shown'] = r['accuracy']['pct']
    raw = max(abs(r['kwh'] - t['use_kwh']) / t['use_kwh'] * 100 if t['use_kwh'] else 0, abs(best_net - costs[best]) / costs[best] * 100 if best in costs else 0)
    out['acc_covers'] = out['accuracy_shown'] is not None and out['accuracy_shown'] >= raw
    # Readings in the file the app did not read, and whether the card said so.
    files = sc.get('files') or [sc['file']]
    warns = r['seen'].get('warns') or [[] for _ in files]
    lost, rep = [], []
    for i, name in enumerate(files):
        m = re.search(r'Imported ([\d,]+) readings', r['seen']['import'][i] if i < len(r['seen']['import']) else '')
        have, rows, distinct = file_readings(name)
        rep.append(round((rows - distinct) / rows * 100, 1) if rows else 0.0)
        got = int(m.group(1).replace(',', '')) if m else 0
        lost.append(round(max(0.0, 1 - got / have) * 100, 1) if have else 0.0)
    out['lost_pct'] = max(lost); out['repeat_pct'] = max(rep); out['warns'] = sorted({w for ws in warns for w in ws})
    out['asked_ids'] = sorted({q['q'] for q in r['seen']['questions'] if q['q'] in ('filewhen', 'fileexp', 'filehome', 'typed', 'hotwater')})
    fails = []
    if out['kwh_err'] is not None and abs(out['kwh_err']) > tol['kwh']: fails.append('consumption')
    if out['bill_err'] is None or abs(out['bill_err']) > tol['bill']: fails.append('bill')
    if out['plan_gap'] is None or out['plan_gap'] > tol['plan']: fails.append('plan')
    if 'current' in out and (out['current_err'] is None or abs(out['current_err']) > tol['bill']): fails.append('current plan')
    if 'payback_err' in out and (out['payback_err'] is None or abs(out['payback_err']) > tol['payback']): fails.append('payback' if out['payback_err'] is not None else 'no payback shown')
    if any(l > 5 and 'unread' not in (warns[i] if i < len(warns) else []) for i, l in enumerate(lost)): fails.append('lost readings, no warning')
    out['fails'] = fails; out['pass'] = not fails; out['tolerance'] = tol
    out['outcome'] = 'asked' if asked else 'accepted'
    out['import_message'] = ' | '.join(r['seen']['import'])[:600]
    out['basis'] = r.get('basis')
    return out

if __name__ == '__main__':
    d = sys.argv[1]
    rows = [score(json.load(open(os.path.join(d, f)))) for f in sorted(os.listdir(d)) if f.endswith('.json') and f != 'scores.json']
    order = list(SC)
    rows.sort(key=lambda r: order.index(r['id']))
    json.dump(rows, open(os.path.join(d, 'scores.json'), 'w'), indent=1)
    for r in rows:
        if r['outcome'] == 'rejected': print(f"{r['id']:22} REJECTED  {r['message'][:110]}"); continue
        cur = f"  current {r['current']} €{r['current_bill']} vs €{r['true_current']} ({r['current_err']}%)" if 'current' in r else ''
        print(f"{r['id']:22} {'PASS' if r['pass'] else 'FAIL':4} kWh {r['kwh']:6} ({r['kwh_err'] if r['kwh_err'] is not None else 'n/a':>6}%)  bill {r['bill_err']}%  gap {r['price_gap']}%  plan {r['best']:18} gap €{r['plan_gap']}  payback {r.get('payback')} vs {r.get('true_payback')}  acc ±{r['accuracy_shown']}%{cur}  {'asked' if r['asked'] else ''} {','.join(r['fails'])}")
