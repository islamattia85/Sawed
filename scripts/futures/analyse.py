"""Score every system from run.mts output across the tariff futures.

    python3 scripts/futures/analyse.py futures-out/attia-raw.json

Prints, for two battery assumptions (replaced in year 12, as the app does
today, and lasting 20 years):
  - the best trade-offs: systems no other system beats on both the average and
    the worst 20-year gain across the core futures
  - where the home's own system sits, and which systems beat it on both counts
  - the least-regret system (smallest worst-case shortfall against the best
    system in each future)
and writes <home>-data.json beside the input, in the shape the prototype page
(prototype/template.html) reads.

Conventions, matching computeNpv20() in src/model.js unless noted:
  - 20 years, 3% discount, 0.5%/yr panel degradation
  - battery replaced in year 12 at EUR 400/kWh (assumption A) or never (B)
  - a future moves in a straight line from today's prices to its end state
    over `ramp_years`, then holds
  - NOT in the app today: export income above EUR 400 a year taxed at 40%
    (the microgeneration disregard; a higher-rate taxpayer). Set --tax 0 to
    match the app exactly.
"""
import json, sys, statistics as st, argparse, os

ap = argparse.ArgumentParser()
ap.add_argument('raw')
ap.add_argument('--tax', type=float, default=0.40, help='marginal rate on export income above the disregard')
ap.add_argument('--disregard', type=float, default=400)
ap.add_argument('--max-panels', type=int, default=20, help='largest system scored (the roof); bigger runs still feed the export chart')
ap.add_argument('--replacement', type=float, default=400, help='EUR per kWh to replace a battery in year 12 (assumption A)')
a = ap.parse_args()

d = json.load(open(a.raw))
S = d['states']
CORE = [f['id'] for f in d['futures'] if f.get('core')]
LABEL = {f['id']: f['label'] for f in d['futures']}
RAMP = d.get('ramp_years', 4)

def after_tax(r):
    return r['benefit'] - a.tax * max(0, r['export_revenue'] - a.disregard)

def value20(net, batt, today, future, repl):
    v = -net
    for y in range(1, 21):
        w = min(1, (y - 1) / RAMP)
        v += ((1 - w) * today + w * future) * 0.995 ** (y - 1) / 1.03 ** y
    if batt and repl:
        v -= repl * batt / 1.03 ** 12
    return v

systems = []
for s in d['systems']:
    if not s.get('own') and s['panels'] > a.max_panels:
        continue
    k = s['id']; net = s['gross'] - s['grant']
    today = after_tax(S['hold']['systems'][k])
    row = dict(id='mine-%d' % s['battery_kwh'] if s.get('own') else '%d-%d' % (s['panels'], s['battery_kwh']),
               mine=bool(s.get('own')), panels=s['panels'], kwp=round(s['kwp'], 1), batt=s['battery_kwh'],
               gross=s['gross'], grant=s['grant'], net=net, savingToday=round(S['hold']['systems'][k]['benefit']))
    row['r12'] = [round(value20(net, s['battery_kwh'], today, after_tax(S[f]['systems'][k]), a.replacement)) for f in CORE]
    row['r20'] = [round(value20(net, s['battery_kwh'], today, after_tax(S[f]['systems'][k]), 0)) for f in CORE]
    systems.append(row)

def name(s):
    if s['mine']: return 'your system (%d panels + %d kWh)' % (s['panels'], s['batt'])
    return '%d panels%s' % (s['panels'], ' + %d kWh' % s['batt'] if s['batt'] else ', no battery')

for mode, title in (('r12', 'Battery replaced in year 12'), ('r20', 'Battery lasts 20 years')):
    grid = [s for s in systems if not s['mine']]
    for s in systems:
        s['_avg'] = st.mean(s[mode]); s['_worst'] = min(s[mode])
    beats = lambda q, s: q['_avg'] >= s['_avg'] and q['_worst'] >= s['_worst'] and (q['_avg'] > s['_avg'] or q['_worst'] > s['_worst'])
    front = sorted([s for s in grid if not any(beats(q, s) for q in grid)], key=lambda s: s['_worst'])
    best = [max(s[mode][i] for s in grid) for i in range(len(CORE))]
    regret = lambda s: max(best[i] - s[mode][i] for i in range(len(CORE)))
    print('\n== %s ==' % title)
    print('Best trade-offs (average / worst 20-year gain):')
    for s in front:
        print('  %-24s €%6.0f / €%6.0f' % (name(s), s['_avg'], s['_worst']))
    for s in systems:
        if s['mine']:
            by = [name(q) for q in grid if beats(q, s)]
            print('%s: €%.0f / €%.0f; beaten on both counts by %d system(s)%s' % (name(s), s['_avg'], s['_worst'], len(by), (': ' + ', '.join(by[:5])) if by else ''))
    lr = min(grid, key=regret)
    print('Least regret: %s (largest shortfall €%.0f)' % (name(lr), regret(lr)))

print('\nYearly saving by export rate (before tax), for the export chart:')
ladder = [f for f in ['exp0', 'exp5', 'exp10', 'exp15', 'hold'] if f in S]
for s in d['systems']:
    if s['id'] in ('30-0', '16-10', '16-0', '10-0') or s.get('own'):
        print('  %-8s %s  net €%d' % (s['id'], [round(S[f]['systems'][s['id']]['benefit']) for f in ladder], s['gross'] - s['grant']))

for s in systems:
    s.pop('_avg', None); s.pop('_worst', None)
out = os.path.join(os.path.dirname(a.raw), d['home']['id'] + '-data.json')
json.dump(dict(futures=[LABEL[f] for f in CORE], systems=systems), open(out, 'w'), separators=(',', ':'))
print('\nwrote', out)
