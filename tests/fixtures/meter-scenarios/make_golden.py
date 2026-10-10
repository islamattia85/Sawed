"""Write golden.json, the limits tests/e2e/golden-households.spec.js holds the app to.

    python3 tests/fixtures/meter-scenarios/make_golden.py <results dir> [--reset] [--loosen=ID:reason ...]

For each reference scenario: where today's result is within the agreed tolerance
(use and bill 5%, payback half a year, best plan or one within EUR 25 a year),
the limit is that tolerance. Where it is not yet, the limit is today's error with
a small margin, marked as a known gap, so a change can only make it better. A fix
that closes a gap should run this again and commit the tighter limits.

Limits only tighten: an existing limit is kept when today's result would loosen
it (that is a regression for the golden test to catch, not a new limit). Pass
--reset to start from today's results alone, or --loosen=ID:reason to take
today's limits for one scenario whose known gap a correct fix made larger (the
reason is kept in golden.json). The warnings the import card gives
and the questions the app asks are kept the same way: once given, they must go
on being given. Where the accuracy figure the app shows covers the error found,
it must go on covering it; where it does not yet, it may not shrink.
"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REFERENCE = ['A1-gas', 'A2-heatpump', 'A7-ev', 'A3a-gas', 'A5b-heatpump', 'B2-gas_solar', 'B2-hp_solar_batt', 'B3-friend',
             'B4a-gas_solar', 'B5-hp_solar_gridfill', 'C1-gas_ev_now', 'D3b-gas', 'D3c-gas', 'D5e-gas',
             # Added 9 October: the user errors with the largest errors, as known gaps until fixed.
             'B3-gas_solar', 'B6-gas_solar', 'B8-gas_solar', 'C3-moved',
             # A file read less than 95% must say so (fix 2, 9 October).
             'D2a-gas',
             # A typed figure the file disagrees with is said, with the choice to keep it (fix 4, 9 October).
             'D6-gas',
             # A battery on a plan with a cheap window, priced with the battery set for each plan,
             # the plan the home is on included (10 October).
             'B9a-hpb_before', 'B9b-hpb_gridfill', 'B9c-hpb_gridfill']
# The solar saving is held to 3% (added with fix 12, 9 October): the app's
# solar on winter time all summer had made every saving 2-2.6% low.
TOL = dict(kwh=5.0, bill=5.0, plan=25, payback=0.5, saving=3.0, current=5.0)
ASKS = ('filewhen', 'fileexp', 'typed', 'filehome', 'hotwater')

def limit(err, tol, step):
    if err is None: return tol
    e = abs(err)
    return tol if e <= tol else round(math.ceil((e * 1.05 + step) / step) * step, 2)

def tighter(old, new):
    """The stricter of two limits; None means no limit yet (a payback not shown)."""
    if old is None or new is None: return new if old is None else old
    return min(old, new)

if __name__ == '__main__':
    rows = {r['id']: r for r in json.load(open(os.path.join(sys.argv[1], 'scores.json')))}
    reference = REFERENCE + [x for x in sys.argv[2:] if not x.startswith('--')]
    loosen = dict(x[len('--loosen='):].split(':', 1) for x in sys.argv[2:] if x.startswith('--loosen='))
    path = os.path.join(HERE, 'golden.json')
    prev = {} if '--reset' in sys.argv or not os.path.exists(path) else json.load(open(path))['scenarios']
    out = {'note': __doc__.strip().split('\n\n')[1].replace('\n', ' '), 'scenarios': {}}
    for sid in dict.fromkeys(reference + list(prev)):
        r = rows[sid]
        if r['outcome'] == 'rejected':
            out['scenarios'][sid] = {'rejected': True, 'why': 'must be turned away with a message'}; continue
        lim = dict(kwh=limit(r['kwh_err'], TOL['kwh'], 0.5), bill=limit(r['bill_err'], TOL['bill'], 0.5), plan=limit(r['plan_gap'], TOL['plan'], 5))
        if r.get('true_payback'):
            lim['payback'] = limit(r['payback_err'], TOL['payback'], 0.1) if r.get('payback_err') is not None else None
        if r.get('saving_err') is not None: lim['saving'] = limit(r['saving_err'], TOL['saving'], 0.5)
        if r.get('current_err') is not None: lim['current'] = limit(r['current_err'], TOL['current'], 0.5)
        p = prev.get(sid, {}) if sid not in loosen else {}
        if sid in loosen: lim['loosened'] = loosen[sid]
        elif prev.get(sid, {}).get('loosened'): lim['loosened'] = prev[sid]['loosened']
        for k in ('kwh', 'bill', 'plan', 'payback', 'saving', 'current'):
            if k in lim and k in p: lim[k] = tighter(p[k], lim[k])
        gaps = [k for k in ('kwh', 'bill', 'plan', 'payback', 'saving', 'current') if lim.get(k) is not None and lim[k] > TOL[k]]
        if 'payback' in lim and lim['payback'] is None: gaps.append('no payback shown')
        # Warnings and questions, once given, stay.
        # A note about repeated rows is held only where the file really repeats them.
        warns = sorted({w for w in (r.get('warns') or []) if w != 'unread-few' and (w != 'dupes' or r.get('repeat_pct', 0) > 1)} | set(p.get('warns') or []))
        if warns: lim['warns'] = warns
        if r.get('lost_pct', 0) > 5: lim['warns'] = sorted(set(warns) | {'unread'})
        asks = sorted({q for q in (r.get('asked_ids') or []) if q in ASKS} | set(p.get('asks') or []))
        if not asks and r.get('asked'): asks = ['filewhen']
        if asks: lim['asks'] = asks
        # The accuracy figure: covers the error found, or (a known gap) may not shrink.
        if r.get('acc_covers') or p.get('acc') == 'covers': lim['acc'] = 'covers'
        else:
            lim['acc_min'] = max(r['accuracy_shown'] or 0, p.get('acc_min') or 0); gaps.append('accuracy')
        if gaps: lim['known_gap'] = ', '.join(gaps)
        elif lim.get('loosened'): del lim['loosened']   # back within the tolerance: the note has served
        lim['today'] = dict(kwh_err=r['kwh_err'], bill_err=r['bill_err'], plan_gap=r['plan_gap'], payback=r.get('payback'), true_payback=r.get('true_payback'), saving_err=r.get('saving_err'), current_err=r.get('current_err'),
                            accuracy=r['accuracy_shown'], lost_pct=r.get('lost_pct'))
        out['scenarios'][sid] = lim
    json.dump(out, open(path, 'w'), indent=1)
    for k, v in out['scenarios'].items(): print(k, {x: v[x] for x in v if x != 'today'})
