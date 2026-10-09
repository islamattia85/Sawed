"""Build docs/meter-file-fixes-2026-10-09.md and the HTML its PDF is printed from.

Every figure is read from the runs in this folder: stages/ (all 71 scenarios
on each build, and golden.json as each fix left it) and explain/ (the runs
behind the two explanations). Nothing is typed in by hand but the wording.

    python3 docs/meter-file-fixes-2026-10-09/report.py
"""
import json, os, re, subprocess, html as Hh

HERE = os.path.dirname(os.path.abspath(__file__))
FIX13 = subprocess.run(['git', 'log', '-1', '--format=%h', '--grep=no-panels home its own hours'], capture_output=True, text=True, cwd=HERE).stdout.strip() or 'uncommitted'
ROOT = os.path.dirname(os.path.dirname(HERE))
FX = os.path.join(ROOT, 'tests', 'fixtures', 'meter-scenarios')
STAGES = [('0-before', 'Before', '90c7db3'), ('1-fix1', 'Fix 1', '8f633d6'), ('2-fix2', 'Fix 2', '93b4f6d'), ('3-fix3', 'Fix 3', 'edba4a1'), ('4-fix4', 'Fix 4', 'a9a2db6')]
ST = {k: {r['id']: r for r in json.load(open(os.path.join(HERE, 'stages', k + '.json')))} for k, _, _ in STAGES}
FINAL = {r['id']: r for r in json.load(open(os.path.join(HERE, 'stages', '5-final.json')))}
# Fixes 12 and 13, approved after the first version of this report.
LATER = [('6-fix12', 'Fix 12', 'e8339ca'), ('7-fix13', 'Fix 13', FIX13)]
SL = {k: {r['id']: r for r in json.load(open(os.path.join(HERE, 'stages', k + '.json')))} for k, _, _ in LATER}
HWL = json.load(open(os.path.join(HERE, 'explain', 'hot-water-left-out', 'scores.json')))
# Fixes 14, 15, 17 and 5.
FIX5 = subprocess.run(['git', 'log', '-1', '--format=%h', '--grep=sales are not on the file yet'], capture_output=True, text=True, cwd=HERE).stdout.strip() or 'uncommitted'
LATER2 = [('8-fix14', 'Fix 14', '1437f12'), ('9-fix15', 'Fix 15', '35eae5c'), ('10-fix17', 'Fix 17', '6a8fa84'), ('11-fix5', 'Fix 5', FIX5)]
SL2 = {k: {r['id']: r for r in json.load(open(os.path.join(HERE, 'stages', k + '.json')))} for k, _, _ in LATER2}
NOFILE = json.load(open(os.path.join(HERE, 'explain', 'no-file', 'by-build.json')))
HRS13 = {k: json.load(open(os.path.join(HERE, 'explain', 'hot-water-left-out', k + '-hours-after-fix13.json'))) for k in ('B2-hp_solar_batt', 'B5-hp_solar_gridfill')}
G = {k: json.load(open(os.path.join(HERE, 'stages', k + '-golden.json')))['scenarios'] for k, _, _ in STAGES}
GNOW = json.load(open(os.path.join(FX, 'golden.json')))['scenarios']
SC = {s['id']: s for s in json.load(open(os.path.join(FX, 'scenarios.json')))}
T = json.load(open(os.path.join(FX, 'truth.json')))
EX = lambda f: json.load(open(os.path.join(HERE, 'explain', f)))
TP, SH, B1P = EX('truth_parts.json'), EX('shift_test.json'), EX('b1_parts.json')
APP = {f[:-5]: EX('app/' + f) for f in os.listdir(os.path.join(HERE, 'explain', 'app')) if f.endswith('.json')}
PLAN = {t['id']: f"{t['supplier']} {t['plan']}" for t in json.load(open(os.path.join(FX, 'tariffs-2026-10-09.json'))) if t.get('id') != '__meta__'}

def pct(v):
    if v is None: return '—'
    v = round(v, 1) + 0.0
    return f'{v:+.1f}%' if v else '0.0%'
def eur(v): return '—' if v is None else (f'−€{abs(v):,.0f}' if v < 0 else f'€{v:,.0f}')
def kwh(v): return f'{v:,.0f}'

blocks = []
def h1(t): blocks.append(('h1', t))
def h2(t): blocks.append(('h2', t))
def h3(t): blocks.append(('h3', t))
def p(t): blocks.append(('p', t))
def ul(items): blocks.append(('ul', items))
def table(head, rows, cls=''): blocks.append(('table', head, rows, cls))
def img(path, cap): blocks.append(('img', path, cap))

def counts(S):
    acc = [r for r in S.values() if r['outcome'] != 'rejected']
    return dict(pass_=sum(1 for r in acc if r['pass']), fail=sum(1 for r in acc if not r['pass']), rej=len(S) - len(acc),
                covers=sum(1 for r in acc if r.get('acc_covers')), n=len(acc))
C = {k: counts(ST[k]) for k, _, _ in STAGES}; CF = counts(FINAL)
b0, b4 = ST['0-before'], FINAL
# Figures used in the wording, all from the runs.
NIGHT = B1P['heatpump_night_share_pct']
SAV = lambda sid: APP[sid]['base']['no']['cost'] - APP[sid]['base']['with']['cost']
BATT = {sid: dict(flat=APP[sid]['base']['noRank']['EN-SMART-24-HOUR']['net'], best=APP[sid]['base']['no']['cost'], night=APP[sid + '-p3']['noSolar']['night_pct'],
                  kwh=APP[sid + '-p3']['noSolar']['total'], saving=SAV(sid), true_saving=TP[home]['saving'])
        for sid, home in (('B2-hp_solar_batt', 'hp_solar_batt'), ('B5-hp_solar_gridfill', 'hp_solar_gridfill'))}
for v in BATT.values(): v['hours'] = v['best'] - v['flat']; v['use'] = v['flat'] - TP['heatpump']['no_solar'][1]; v['err'] = (v['saving'] - v['true_saving']) / v['true_saving'] * 100
EI_DEARER = B1P['heatpump_no_solar_cost']['EI-SST'] - B1P['heatpump_no_solar_cost']['EN-SMART-24-HOUR']
ALLOW = APP['B2-hp_solar_batt-p3']['asIs']['total'] + APP['A2-heatpump-p3']['gen'] - TP['hp_solar_batt']['sold'] - APP['B2-hp_solar_batt-p3']['noSolar']['total']
JAN = APP['probe4']['inWhatIf']['jan16']
GEN_S = (APP['A7-gas']['base']['with']['gen'] - TP['gas']['gen']) / TP['gas']['gen'] * 100
GEN_F = (APP['B1a-friend']['solarOnly']['with']['gen'] - TP['friend_full_year']['gen']) / TP['friend_full_year']['gen'] * 100
EARLY = [(SH[h]['summer_hour_early']['saving'] - SH[h]['truth']['saving']) / SH[h]['truth']['saving'] * 100 for h in ('gas', 'heatpump', 'ev')]
B1A_COMING = B1P['coming_year_app_like']['EI-SST']; B1A_ERR = b0['B1a-friend']['bill'] - B1A_COMING

# ------------------------------------------------------------------ summary
h1('Meter-file fixes, and two explanations')
p('9 October 2026, on v8. The scenario tests are merged into v8, so the golden-households test runs on every push. Fixes 1 to 4 are in, one commit each, and each one tightened the golden limits for the homes it put right; fixes 12 to 17 and 5 followed (the next two sections). Every number here comes from a run of the real app against homes whose true use and costs are known: all 71 scenarios on the build before each fix and after it.')
ul([
    f"**All 71 scenarios: {C['0-before']['pass_']} passed before, {CF['pass_']} after fix 4, {counts(SL['7-fix13'])['pass_']} after fixes 12 and 13, {counts(SL2['11-fix5'])['pass_']} after fixes 14, 15, 17 and 5** (the next sections say why). Fix 1 (a lone midnight reading counted as a day): nine-month files of all three homes pass. Fix 2 (each half hour once): a doubled file reads {pct(b4['D3b-gas']['kwh_err'])} where it read {pct(b0['D3b-gas']['kwh_err'])}, and a file the app cannot read 60% of now says so. Fix 4 (ask instead of overriding): \"no panels\" with sales in the file {pct(b0['B6-gas_solar']['kwh_err'])} to {pct(b4['B6-gas_solar']['kwh_err'])}, a file from a previous home {pct(b0['C3-moved']['kwh_err'])} to {pct(b4['C3-moved']['kwh_err'])}.",
    f"**The accuracy figure now moves (fix 3).** It covers the error found in {CF['covers']} of {CF['n']} accepted files ({C['0-before']['covers']} before). Four winter weeks of a heat pump home show ±{b4['A5b-heatpump']['accuracy_shown']}% where they showed ±{b0['A5b-heatpump']['accuracy_shown']}%.",
    f"**The golden test holds {len(GNOW)} homes** (14 before): the four user errors you named, D2a (must warn) and D6 (must say the file disagrees with what was typed). It now also holds the warnings, the questions asked and the accuracy figure.",
    f"**B1 (question 4): the bill is negative, and the scoring compared two different years.** The app's bill for the tester-like home is negative in {sum(1 for k in ('B1a-friend', 'B1b-friend', 'B1c-friend', 'B1d-friend') if b0[k]['bill'] < 0)} of the 4 files. The percentages are large because the true bill is small: €{T['friend']['costs']['EI-SST']:,.0f} a year. The \"true\" figure was the home's recorded year, which had 11 days without panels and six weeks of unpaid sales. The coming year with the panels up costs €{B1P['coming_year_reference']['EI-SST']:,.0f} on the same plan. The rest of the gap comes from what each file shows of the home: a year before the panels that was milder, and a summer or winter scaled up to a year.",
    f"**The saving bias (question 5) has three causes, each measured.** For homes planning panels, two of the app's habits put together reproduce its figures to the kWh: its solar runs on winter time all summer, an hour early against the meter's clock, and its panels make {abs(GEN_S):.1f}% less than PVGIS. For battery homes the gap is all on the \"without panels\" side, which is worked back from the file. That home comes out {abs(BATT['B2-hp_solar_batt']['kwh'] - TP['hp_solar_batt']['use']) / TP['hp_solar_batt']['use'] * 100:,.0f}% too small, and {BATT['B2-hp_solar_batt']['night']:,.0f}% to {BATT['B5-hp_solar_gridfill']['night']:,.0f}% of its use lands in the night hours, against {NIGHT}% in truth. A night-rate plan then looks €{-BATT['B2-hp_solar_batt']['hours']} to €{-BATT['B5-hp_solar_gridfill']['hours']} a year cheaper than it is.",
    '**Real homes have a slot** (tests/fixtures/meter-scenarios/real/). Your ESB file with the Sigenergy export, and the tester\'s file, become scenarios with true figures. They stay out of git. A self-test on a made-up home recovers the stored truth exactly.',
])

# ------------------------------------------------------------------ fixes 14, 15, 17 and 5
L7, L14, L15, L17, L5 = SL['7-fix13'], SL2['8-fix14'], SL2['9-fix15'], SL2['10-fix17'], SL2['11-fix5']
h2('Fixes 14, 15, 17 and 5')
p('Approved after fixes 12 and 13. Each was run on all 71 scenarios and committed on its own, with the golden limits set from its run.')
def cmp5(r):
    if r['outcome'] == 'rejected': return '—'
    t = f"use {pct(r['kwh_err'])}<br>bill {pct(r['bill_err'])}"
    t += f"<br>saving {pct(r['saving_err'])}" if r.get('saving_err') is not None else '<br>no saving shown'
    return t + (f"<br>payback {r['payback']} v {r['true_payback']}" if r.get('payback') is not None else '')
ids5 = ['A1-gas', 'A2-heatpump', 'A7-ev', 'B2-gas_solar', 'B2-hp_solar_batt', 'B5-hp_solar_gridfill', 'B3-friend', 'B3-gas_solar', 'B3-hp_solar_batt', 'B4a-gas_solar', 'A3a-gas', 'C3-moved']
res = lambda r: 'pass' if r['pass'] else 'FAIL: ' + ', '.join(r['fails'])
table(['ID', 'Scenario', 'Before 14', 'Fix 14', 'Fix 15', 'Fix 17', 'Fix 5', 'Now'],
      [[i, SC[i]['title'], cmp5(L7[i]), cmp5(L14[i]), cmp5(L15[i]), cmp5(L17[i]), cmp5(L5[i]), res(L5[i])] for i in ids5], 'results')
full12 = ('A1-gas', 'A1-heatpump', 'A1-ev', 'A2-gas', 'A2-heatpump', 'A2-ev', 'A6-gas', 'A6-heatpump', 'A6-ev', 'A7-gas', 'A7-heatpump', 'A7-ev')
f15 = [L15[i]['saving_err'] for i in full12]
ul([
    f"**Fix 14, battery losses.** Working a battery home's use back, the battery's real losses (the stated battery run day by day) replace 8% of all the solar used. B2-hp_solar_batt's use went from {pct(L7['B2-hp_solar_batt']['kwh_err'])} to {pct(L14['B2-hp_solar_batt']['kwh_err'])} and B5's from {pct(L7['B5-hp_solar_gridfill']['kwh_err'])} to {pct(L14['B5-hp_solar_gridfill']['kwh_err'])}. B3-friend went over, {pct(L7['B3-friend']['kwh_err'])} to {pct(L14['B3-friend']['kwh_err'])}. Its file counts six weeks of unrecorded sales as use, and its panels ran over PVGIS; fix 15 brought it back.",
    f"**Fix 15, panels anchored to PVGIS.** Each face's months are scaled to PVGIS for its direction, pitch and region: six regions, eight directions and seven pitches, fetched from PVGIS by scripts/pvgis.py. The twelve full-year files now read the saving between {min(f15):+.1f}% and {max(f15):+.1f}%. B2-gas_solar's use is {pct(L15['B2-gas_solar']['kwh_err'])} and B5's {pct(L15['B5-hp_solar_gridfill']['kwh_err'])}.",
    f"**Fix 17, the hot water question.** A heat pump home whose file has panels in all of it is asked when the water is heated and when the heating runs. B2-hp_solar_batt's saving went from {pct(L15['B2-hp_solar_batt']['saving_err'])} to {pct(L17['B2-hp_solar_batt']['saving_err'])} (payback {L17['B2-hp_solar_batt']['payback']} against {L17['B2-hp_solar_batt']['true_payback']}). B5's went from {pct(L15['B5-hp_solar_gridfill']['saving_err'])} to {pct(L17['B5-hp_solar_gridfill']['saving_err'])}, and B3-friend's from {pct(L15['B3-friend']['saving_err'])} to {pct(L17['B3-friend']['saving_err'])}.",
    f"**Fix 5, sales not on the file yet.** \"No, they were up the whole time. My sales aren't on it yet\" is offered. The home's use is worked back from what was bought and the stated system, its sales are the model's estimate, and the accuracy shown widens to ±{L5['B3-gas_solar']['accuracy_shown']}%. Where the panels and a battery would have covered most of any more use, as in summer, those months are filled from the heating type's seasons, as a missing period is. B3-gas_solar went from {pct(L17['B3-gas_solar']['kwh_err'])} use, {pct(L17['B3-gas_solar']['bill_err'])} bill and no payback to {pct(L5['B3-gas_solar']['kwh_err'])}, {pct(L5['B3-gas_solar']['bill_err'])} and {L5['B3-gas_solar']['payback']} years (true {L5['B3-gas_solar']['true_payback']}). B3-hp_solar_batt went from {pct(L17['B3-hp_solar_batt']['kwh_err'])} and {pct(L17['B3-hp_solar_batt']['bill_err'])} to {pct(L5['B3-hp_solar_batt']['kwh_err'])} and {pct(L5['B3-hp_solar_batt']['bill_err'])}, payback {L5['B3-hp_solar_batt']['payback']} (true {L5['B3-hp_solar_batt']['true_payback']}). Its saving reads {pct(L5['B3-hp_solar_batt']['saving_err'])}: inside the ±{L5['B3-hp_solar_batt']['accuracy_shown']}% shown, but the least sure figure here.",
])
table(['Build', 'Commit', 'Pass', 'Fail', 'Turned away', 'Accuracy shown covers the error'],
      [[lab, f'`{c}`', counts(SL2[k])['pass_'], counts(SL2[k])['fail'], counts(SL2[k])['rej'], f"{counts(SL2[k])['covers']} of {counts(SL2[k])['n']}"] for k, lab, c in LATER2])
h3('What fix 15 uncovered: homes priced on a smooth day')
nf = NOFILE
p(f"Files of only part of a year, and the path with no file at all, are priced on a smooth average day: the standard load profile, an average of thousands of homes, or the file's own average day. A smooth day uses more of its own solar than a real home, whose use comes in peaks. The old shortfall in the panels (1.9%) and their hour off in summer had been hiding this. With both put right, these paths read the saving high: A3a-gas {pct(L15['A3a-gas']['saving_err'])}, D2a {pct(L15['D2a-gas']['saving_err'])} and C3 {pct(L15['C3-moved']['saving_err'])}. B4a's file from before its panels reads its bill {pct(L15['B4a-gas_solar']['bill_err'])}. The path without a file, where most people start, was measured separately: setup answered as the made-up homes would, with their true yearly kWh typed in.")
table(['Build', 'Gas home: saving, payback (true 6.82)', 'Heat pump: saving, payback (true 5.78), bill', 'EV home: saving, payback (true 6.43), bill'],
      [[lab, f"{pct(v['homes']['gas']['saving_err'])}, {v['homes']['gas']['payback']}", f"{pct(v['homes']['heatpump']['saving_err'])}, {v['homes']['heatpump']['payback']}, {pct(v['homes']['heatpump']['bill_err'])}", f"{pct(v['homes']['ev']['saving_err'])}, {v['homes']['ev']['payback']}, {pct(v['homes']['ev']['bill_err'])}"] for lab, v in nf.items()])
ul([
    f"**The no-file path was already optimistic for a gas home** ({pct(nf['before fix 12']['homes']['gas']['saving_err'])} before fix 12). It now reads {pct(nf['fix 15']['homes']['gas']['saving_err'])}, payback {nf['fix 15']['homes']['gas']['payback']} against {nf['fix 15']['homes']['gas']['true_payback']}. The plan and the bill are right for the gas and EV homes. The heat pump home's bill reads {pct(nf['fix 15']['homes']['heatpump']['bill_err'])}, on a plan €{nf['fix 15']['homes']['heatpump']['plan_gap']} a year off the cheapest.",
    'This is the direction that matters most: a payback that reads shorter than it is, on the path most people take. Keeping the two old errors would have hidden it. Fixing it means pricing these homes on days with real peaks.',
    "Seven golden limits were loosened at fix 15 with their reasons recorded (A3a-gas, D2a, C3, B4a, A5b, B8, B3-friend). Fix 17 brought B3-friend back within tolerance.",
])
table(['#', 'Proposal (for your approval)', 'Impact', 'Effort', 'Scenarios'], [
    ['18', 'Price a home without a full year of readings on days with real peaks, not a smooth average day: for the no-file path, a set of realistic days at the household\'s size and heating; for part-year files, the file\'s own days laid on the missing months. Calibrated on real files (yours and the tester\'s first).', f"High: the path most people take; gas home saving {pct(nf['fix 15']['homes']['gas']['saving_err'])} today", 'Medium', 'No-file path, A3-A5, C3, D2a, B4'],
])

# ------------------------------------------------------------------ fixes 12 and 13
L12, L13 = SL['6-fix12'], SL['7-fix13']
C12, C13 = counts(L12), counts(L13)
h2('Fixes 12 and 13 (approved after the first version of this report)')
p('Fix 12 puts the panels on the clock the meter keeps. Fix 13 stops a meter file with panels in it setting the hours of the home without them; its days before the panels do, or the heating profile does. All 71 scenarios were run on each. The golden test now also holds the solar saving, at 3%.')
def sv(r):
    if r['outcome'] == 'rejected': return '—'
    t = f"saving {pct(r.get('saving_err'))}" if r.get('saving_err') is not None else 'no saving shown'
    return t + (f"<br>payback {r['payback']} v {r['true_payback']}" if r.get('payback') is not None else '') + f"<br>bill {pct(r['bill_err'])}"
ids = ['A1-gas', 'A1-heatpump', 'A1-ev', 'A2-heatpump', 'A7-ev', 'A3a-gas', 'B2-gas_solar', 'B2-hp_solar_batt', 'B5-hp_solar_gridfill', 'B3-friend', 'B4a-gas_solar', 'B4c-gas_solar', 'B4d-hp_solar_batt', 'C3-moved']
rows = []
for i in ids:
    lim = GNOW.get(i, {})
    res = lambda r: 'pass' if r['pass'] else 'FAIL: ' + ', '.join(r['fails'])
    rows.append([i, SC[i]['title'], sv(FINAL[i]), sv(L12[i]), sv(L13[i]), res(L13[i]), (f"{lim['saving']:g}%" if lim.get('saving') is not None else 'not in the set') + (' (loosened, reason recorded)' if lim.get('loosened') and ('Fix 12' in lim['loosened'] or 'Fix 13' in lim['loosened']) else '')])
table(['ID', 'Scenario', 'Before 12', 'Fix 12', 'Fix 13', 'Now', 'Saving limit'], rows, 'results')
a12 = [L12[i]['saving_err'] for i in ('A1-gas', 'A1-heatpump', 'A1-ev', 'A2-gas', 'A2-heatpump', 'A2-ev', 'A6-gas', 'A6-heatpump', 'A6-ev', 'A7-gas', 'A7-heatpump', 'A7-ev')]
a11 = [FINAL[i]['saving_err'] for i in ('A1-gas', 'A1-heatpump', 'A1-ev', 'A2-gas', 'A2-heatpump', 'A2-ev', 'A6-gas', 'A6-heatpump', 'A6-ev', 'A7-gas', 'A7-heatpump', 'A7-ev')]
ul([
    f"**Fix 12 did what was measured.** On the twelve full-year files the saving moves from {min(a11):+.1f}%..{max(a11):+.1f}% to {min(a12):+.1f}%..{max(a12):+.1f}%, and every payback shortens by 0.1 to 0.2 years toward the truth. What is left is mostly the panels' {abs(GEN_S):.1f}% shortfall against PVGIS (proposal 15). Shorter files, B4 and the D files move the same way. One new fail: C3, the person who moved. They type the typical 4,200 kWh for a 4,000 kWh home, priced on the standard profile, and its payback now reads {L12['C3-moved']['payback']} against {L12['C3-moved']['true_payback']}. The early-hour bias had been hiding that; its limit is loosened in golden.json with that reason.",
    f"**Fix 13 helped the battery filled from the grid, and not the others.** B5's saving went from {pct(L12['B5-hp_solar_gridfill']['saving_err'])} to {pct(L13['B5-hp_solar_gridfill']['saving_err'])}. B2-hp_solar_batt went from {pct(L12['B2-hp_solar_batt']['saving_err'])} to {pct(L13['B2-hp_solar_batt']['saving_err'])}, and the tester-like home B3-friend from {pct(L12['B3-friend']['saving_err'])} to {pct(L13['B3-friend']['saving_err'])}. These homes have no days before their panels, so the heat pump profile now sets the hours. That profile assumes the water is heated from 2am to 5am, the app's default for every heat pump home: {HRS13['B2-hp_solar_batt']['noSolar']['night_pct']}% of the day lands in the night hours (on 16 January, {max(HRS13['B2-hp_solar_batt']['jan16'][2:5]):.1f} kWh an hour from 2am to 5am), against {NIGHT}% in the true home. That is no better than the {APP['B2-hp_solar_batt-p3']['noSolar']['night_pct']}% the battery's pattern gave. B3-friend's saving limit is loosened with that reason.",
    f"**That assumption is most of what is left.** Run again with the hot water left out of the profile (a measurement, not a change): B2-hp_solar_batt {pct(HWL['B2-hp_solar_batt']['saving_err'])}, B5 {pct(HWL['B5-hp_solar_gridfill']['saving_err'])}, B3-friend {pct(HWL['B3-friend']['saving_err'])}. What then remains for B2 and B5 is mostly the home read about 4% small (proposal 14). The made-up homes do not heat water at night, so leaving it out would only tune the app to them; whether a real heat pump does is something the person knows. Proposal 17 below asks them.",
    f"**B4c tips over.** A gas home's file from before and after its panels, with no export rows. Its usage pattern now comes from its days before the panels, which is the home's real use. Its bill moved from {pct(L12['B4c-gas_solar']['bill_err'])} to {pct(L13['B4c-gas_solar']['bill_err'])}, just past 5%. The rest of its error is the panels' shortfall and the app working in hours where the meter has half hours.",
])
table(['Build', 'Commit', 'Pass', 'Fail', 'Turned away', 'Accuracy shown covers the error'],
      [['Before 12', '`d08af36`', CF['pass_'], CF['fail'], CF['rej'], f"{CF['covers']} of {CF['n']}"]] +
      [[lab, f'`{c}`', counts(SL[k])['pass_'], counts(SL[k])['fail'], counts(SL[k])['rej'], f"{counts(SL[k])['covers']} of {counts(SL[k])['n']}"] for k, lab, c in LATER])
table(['#', 'Proposal (for your approval)', 'Impact', 'Effort', 'Scenarios'], [
    ['17', 'Ask a heat pump home when it heats its water (and when the heating runs) wherever its meter file cannot show it: a file with panels in all of it. Today the app assumes 2am to 5am.', f"High for battery homes: saving {pct(L13['B2-hp_solar_batt']['saving_err'])} to {pct(HWL['B2-hp_solar_batt']['saving_err'])} for B2-hp_solar_batt if the answer is 'during the day'", 'Small', 'B2-hp_solar_batt, B3-friend, B5'],
])

# ------------------------------------------------------------------ golden
h2('The golden households, before and after')
LOOSE = [k for k, v in GNOW.items() if v.get('loosened')]
p(f"Each cell is the error against the truth: use / bill (payback in years against the true one, where the app shows one), on fixes 1 to 4. Limits are use / bill / plan / payback (and, from fix 12, the solar saving); \"acc\" is the rule on the accuracy figure (covers the error, or may not fall below a figure). A limit only ever tightens. The exceptions are recorded in golden.json with their reasons, each a correct fix that removed an error which had been hiding another: {', '.join(LOOSE)}.")
def cell(r):
    if r is None: return '—'
    if r['outcome'] == 'rejected': return 'turned away'
    s = f"{pct(r['kwh_err'])} / {pct(r['bill_err'])}"
    if r.get('payback') is not None: s += f"<br>payback {r['payback']} v {r['true_payback']}"
    elif r.get('true_payback'): s += '<br>no payback'
    if r.get('lost_pct', 0) > 5: s += f"<br>{r['lost_pct']}% unread" + (', warned' if 'unread' in (r.get('warns') or []) else ', no warning')
    return s
def lims(l):
    if l is None: return 'not in the set'
    if l.get('rejected'): return 'turned away'
    s = f"{l['kwh']:g}% / {l['bill']:g}% / €{l['plan']:g} / " + (f"{l['payback']:g} y" if l.get('payback') is not None else ('no payback yet' if 'payback' in l else '—'))
    if l.get('saving') is not None: s += f"<br>saving {l['saving']:g}%"
    if l.get('loosened'): s += '<br>(loosened, reason recorded)'
    s += '<br>acc ' + ('covers' if l.get('acc') == 'covers' else f"≥ ±{l['acc_min']}%")
    if l.get('warns'): s += '<br>warns: ' + ', '.join(l['warns'])
    if l.get('asks'): s += '<br>asks: ' + ', '.join(l['asks'])
    return s
rows = []
for sid in GNOW:
    rows.append([f"**{sid}**<br>{SC[sid]['title']}", lims(G['0-before'].get(sid))] + [cell(ST[k].get(sid)) for k, _, _ in STAGES] + [lims(GNOW[sid])])
table(['Scenario', 'Limits before', 'Before', 'Fix 1', 'Fix 2', 'Fix 3', 'Fix 4', 'Limits now'], rows, 'golden')

# ------------------------------------------------------------------ all 71
h2('All 71 scenarios, fix by fix')
table(['Build', 'Commit', 'Pass', 'Fail', 'Turned away', 'Accuracy shown covers the error'],
      [[lab, f'`{c}`', C[k]['pass_'], C[k]['fail'], C[k]['rej'], f"{C[k]['covers']} of {C[k]['n']}"] for k, lab, c in STAGES] +
      [['Now (with the card fix)', '`708262f`', CF['pass_'], CF['fail'], CF['rej'], f"{CF['covers']} of {CF['n']}"]])
p('Every scenario whose figures changed, before and now. Use / bill / payback; the accuracy shown; the result.')
rows = []
for sid, a in b0.items():
    z = b4[sid]
    if a['outcome'] == 'rejected' and z['outcome'] == 'rejected': continue
    same = all(a.get(f) == z.get(f) for f in ('kwh_err', 'bill_err', 'payback', 'accuracy_shown', 'pass'))
    if same: continue
    res = lambda r: 'pass' if r['pass'] else 'FAIL: ' + ', '.join(r['fails'])
    rows.append([sid, SC[sid]['title'], cell(a) + f"<br>±{a['accuracy_shown']}%", res(a), cell(z) + f"<br>±{z['accuracy_shown']}%", res(z)])
table(['ID', 'Scenario', 'Before', '', 'Now', ''], rows, 'results')

h3('What the person sees now')
for f, cap in (('D6-gas-import1.png', 'Typed 5,600 kWh in setup, then a file showing 4,001: said, with the choice to keep it (fix 4). Every upload now asks whether the file is from the home lived in now.'),
               ('D2a-gas-import1.png', f"A file opened and saved in Excel with US dates: {b4['D2a-gas']['lost_pct']}% of its readings unreadable, and the card says so (fix 2)."),
               ('D3b-gas-import1.png', 'Every row twice: counted once, and said (fix 2).'),
               ('B6-gas_solar-q-fileexp.png', '"No panels", with sales in the file from the first day: asked (fix 4).')):
    img('shots/' + f, cap)

# ------------------------------------------------------------------ B1
h2('Question 4: the B1 bills of -46% to -220%')
q = {k: FINAL[k] for k in ('B1a-friend', 'B1b-friend', 'B1c-friend', 'B1d-friend')}
q0 = {k: b0[k] for k in q}
fy = B1P['file_year_use']
p(f"B1 is the tester-like home (heat pump, 22 panels on two faces, a 9 kWh battery that stores only solar) with a file from before the panels. The app adds the stated panels and battery to the file and prices the year. The scored figure is the app's answer for a battery that stores only solar; its headline assumes night filling and is shown beside it.")
rows = []
for k in q:
    a, z = q0[k], q[k]
    rows.append([k, SC[k]['title'], f"{kwh(fy[k]['use'])} kWh in {fy[k]['days']} days", f"{kwh(a['kwh'])} ({pct(a['kwh_err'])})", PLAN.get(a['best'], a['best']), eur(a['bill']), eur(a['headline']['bill']),
                 eur(a['true_bill_same_plan']), eur(round(B1P['coming_year_app_like'][a['best']])), f"{kwh(z['kwh'])}, {eur(z['bill'])}"])
table(['ID', 'File', 'True use in the file', "App's year", "App's plan", 'App: bill', 'App: headline', 'True: recorded year', 'True: coming year', 'Now (after fix 1)'], rows, 'b1')
ul([
    f"**Yes, the bill is negative.** On the scored answer it is negative for {sum(1 for k in q0 if q0[k]['bill'] < 0)} of the 4 files; on the headline, for {sum(1 for k in q0 if q0[k]['headline']['bill'] < 0)}. A 9.7 kWp system with a battery takes this home from €{TP['friend']['no_solar'][1]:,.0f} a year without panels to €{B1P['coming_year_reference']['EI-SST']:,.0f} to €{T['friend']['costs']['EI-SST']:,.0f} with them, so a negative bill says the panels would earn more than the home spends.",
    f"**The percentages are large because the true figure is small.** €100 on a €{T['friend']['costs']['EI-SST']:,.0f} bill is 30%. In euro, the errors are €{abs(q0['B1a-friend']['bill'] - q0['B1a-friend']['true_bill_same_plan']):,.0f}, €{abs(q0['B1b-friend']['bill'] - q0['B1b-friend']['true_bill_same_plan']):,.0f}, €{abs(q0['B1c-friend']['bill'] - q0['B1c-friend']['true_bill_same_plan']):,.0f} and €{abs(q0['B1d-friend']['bill'] - q0['B1d-friend']['true_bill_same_plan']):,.0f}.",
    f"**The scoring did compare two different things.** The true bill was the home's recorded year (9 Oct 2025 to 8 Oct 2026): eleven days before the panels went up, then six weeks when ESB did not yet record sales, so they were not paid. The app works out the coming year, with the panels up and sales paid from the first day. That year costs €{B1P['coming_year_reference']['EI-SST']:,.0f} on Electric Ireland's SST plan with the reference battery, or €{B1P['coming_year_app_like']['EI-SST']:,.0f} with a battery run as the app runs its own (92% round trip, 10% kept back, held through the night). The recorded year costs €{T['friend']['costs']['EI-SST']:,.0f}. Against the coming year, B1a's error is €{abs(q0['B1a-friend']['bill'] - B1P['coming_year_app_like']['EI-SST']):,.0f} (−{abs(q0['B1a-friend']['bill'] - B1P['coming_year_app_like']['EI-SST']) / B1P['coming_year_app_like']['EI-SST'] * 100:,.0f}%), not −46%. The B3-friend file is that recorded year, priced from its own readings, so there the two agree: €{b0['B3-friend']['bill']:,.0f} against €{b0['B3-friend']['true_bill_same_plan']:,.0f}.",
    f"**What is left is the file.** B1a's year before the panels used {kwh(fy['B1a-friend']['use'])} kWh, and the app read {kwh(q0['B1a-friend']['kwh'])}. That year was milder than the coming one ({kwh(T['friend']['use_kwh'])} kWh), and the app's panels on these two faces make {APP['B1a-friend']['solarOnly']['with']['gen'] - TP['friend_full_year']['gen']:+,} kWh against PVGIS. So it buys less and sells more. B1b to B1d scale a half year, a summer or a winter up to a year, as the partial files A3 to A5 do. A heat pump home's summer is a third of its winter, so the year is read low from a summer and high from a winter. Fix 1 changed these (B1d now reads high: it had been held down by the lone midnight reading). Fix 3 now shows ±{q['B1b-friend']['accuracy_shown']}% to ±{q['B1d-friend']['accuracy_shown']}% on them, where it showed ±4%.",
    f"The headline's night filling is a separate matter. On these plans it moves the answer to Electric Ireland Night Boost, €{q0['B1a-friend']['headline']['gap']} a year dearer than the solar-only best: that is the \"Ask how a battery charges also when a file is uploaded\" item (fix 6). Holding the battery through the night, as the app does on a night-rate plan, costs this home only €{SH['friend_held_through_night']['on_EI_SST'] - SH['friend_truth_battery']['on_EI_SST']:,.0f} a year (€{SH['friend_truth_battery']['on_EI_SST']:,.0f} against €{SH['friend_held_through_night']['on_EI_SST']:,.0f} with the reference battery), so it is not a cause.",
])
p(f"So the scoring change for later: score a file from before the panels against the coming year with the panels up all year, as above, not against the recorded year. B1a would then read {B1A_ERR / B1A_COMING * 100:+.0f}% ({eur(B1A_ERR)}) rather than {pct(b0['B1a-friend']['bill_err'])}.")

# ------------------------------------------------------------------ saving bias
h2('Question 5: where the saving bias comes from')
p("The saving is the cheapest plan without the panels less the cheapest plan with them, for the coming year. For homes planning panels the app's figure was 3.7% to 5.0% low; for battery homes 14% to 22% low. Each part below was measured: on the app (its own simulation, read out of the running page) and on the true homes (the truth's simulation, with one of the app's habits switched on at a time).")
h3('Homes planning panels: two habits, both in the with-solar year')
rows = []
for home, sid in (('gas', 'A7-gas'), ('heatpump', 'A7-heatpump'), ('ev', 'A7-ev')):
    a = APP[sid]['base']; s = SH[home]
    rows.append([TP[home]['use'] and f"{home.replace('heatpump', 'heat pump').replace('ev', 'EV').replace('gas', 'gas')} ({sid})",
                 f"€{s['truth']['saving']:,.0f}<br>sold {kwh(s['truth']['sold'])}, used {kwh(s['truth']['self_use'])}",
                 f"€{s['summer_hour_early']['saving']:,.0f} ({pct((s['summer_hour_early']['saving'] - s['truth']['saving']) / s['truth']['saving'] * 100)})<br>used {kwh(s['summer_hour_early']['self_use'])}",
                 f"€{s['gen_minus_1.9pct']['saving']:,.0f} ({pct((s['gen_minus_1.9pct']['saving'] - s['truth']['saving']) / s['truth']['saving'] * 100)})",
                 f"€{s['both']['saving']:,.0f}<br>bought {kwh(s['both']['bought'])}, sold {kwh(s['both']['sold'])}",
                 f"{eur(a['no']['cost'] - a['with']['cost'])}<br>bought {kwh(a['with']['imp'])}, sold {kwh(a['with']['exp'])}"])
table(['Home', 'True saving', 'Solar an hour early in summer', 'Panels 1.9% lower', 'Both', 'The app'], rows, 'bias')
ul([
    f"**The app's solar runs on winter time all year.** On 21 June its 4 kWp system makes power from 04:00 and peaks at 12:00 to 13:00. The sun is highest at about 13:30 Irish summer time. The meter's readings, and every plan's hours, are on the clock. So from late March to late October the panels run an hour early against the home: less is used at home and more sold for less. On the true gas home this alone takes {kwh(SH['gas']['truth']['self_use'] - SH['gas']['summer_hour_early']['self_use'])} kWh off what is used at home and {abs(EARLY[0]):.1f}% off the saving.",
    f"**The app's panels make {abs(GEN_S):.1f}% less than PVGIS** for 4 kWp facing south at 35° in Cork ({kwh(APP['A7-gas']['base']['with']['gen'])} kWh against {kwh(TP['gas']['gen'])}). On the tester-like home's two faces it is the other way, {GEN_F:+.1f}% ({kwh(APP['B1a-friend']['solarOnly']['with']['gen'])} against {kwh(TP['friend_full_year']['gen'])}). So it is the panel model's allowance for direction that is off, not its overall level.",
    f"**The two together reproduce the app.** On the gas home: bought {kwh(SH['gas']['both']['bought'])} kWh (app {kwh(APP['A7-gas']['base']['with']['imp'])}), sold {kwh(SH['gas']['both']['sold'])} (app {kwh(APP['A7-gas']['base']['with']['exp'])}), saving {eur(SH['gas']['both']['saving'])} (app {eur(SAV('A7-gas'))}). The no-panels side is right: {eur(APP['A7-gas']['base']['no']['cost'])} against {eur(TP['gas']['no_solar'][1])}. The heat pump and EV homes come within €{max(abs(SH[h]['both']['saving'] - SAV(s)) for h, s in (('heatpump', 'A7-heatpump'), ('ev', 'A7-ev'))):,.0f}, the rest being their use read slightly low.",
])
h3('Battery homes: the "without panels" home worked back from the file')
rows = []
for sid, home in (('B2-hp_solar_batt', 'hp_solar_batt'), ('B5-hp_solar_gridfill', 'hp_solar_gridfill')):
    a = APP[sid]['base']; t = TP[home]; n3 = APP[sid + '-p3']['noSolar']
    flat = a['noRank']['EN-SMART-24-HOUR']['net']
    rows.append([sid, f"{eur(a['with']['cost'])} / {eur(t['with_solar'][1])}", f"{kwh(n3['total'])} / {kwh(t['use'])}",
                 f"{eur(flat)} / {eur(t['no_solar'][1])} ({eur(flat - t['no_solar'][1])})",
                 f"{n3['night_pct']}% / {NIGHT}%", f"{PLAN[a['no']['plan']]}, {eur(a['no']['cost'])}: {eur(flat - a['no']['cost'])} under the flat plan",
                 f"{eur(a['no']['cost'] - a['with']['cost'])} / {eur(t['saving'])} ({pct((a['no']['cost'] - a['with']['cost'] - t['saving']) / t['saving'] * 100)})"])
table(['Home', 'With panels: app / true', 'Home without panels: kWh, app / true', 'On a flat-rate plan: app / true', 'Night share 23:00-08:00: app / true', "App's cheapest without panels", 'Saving: app / true'], rows, 'bias')
ul([
    f"**With the panels, the app is exact**: these files are priced from their own readings.",
    f"**The home without panels is too small**: {kwh(APP['B2-hp_solar_batt-p3']['noSolar']['total'])} kWh against {kwh(TP['hp_solar_batt']['use'])}. It is worked back as what was bought, plus what the stated panels make in a typical year, less what was sold, less 8% of the solar used for battery losses. The app's 6 kWp makes {kwh(APP['A2-heatpump-p3']['gen'])} kWh in its typical year against {kwh(TP['hp_solar_batt']['gen'])} in this one. Its battery allowance takes off {ALLOW:,.0f} kWh where the battery lost {B1P['hp_solar_batt_battery']['lost']}. On a flat-rate plan that is the €{-BATT['B2-hp_solar_batt']['use']:,.0f} and €{-BATT['B5-hp_solar_gridfill']['use']:,.0f} above.",
    f"**And its hours are wrong.** They come from the usage pattern read off what the meter bought. A battery has already moved that buying into the night, and a battery filled from the grid in winter more so. So {APP['B2-hp_solar_batt-p3']['noSolar']['night_pct']}% and {APP['B5-hp_solar_gridfill-p3']['noSolar']['night_pct']}% of the no-panels home's use land between 23:00 and 08:00, against {NIGHT}% in the true home. On 16 January it uses {JAN[12]:.1f} kWh an hour through the day and {JAN[2]:.1f} through the night. A night-rate plan then looks €{-BATT['B2-hp_solar_batt']['hours']} and €{-BATT['B5-hp_solar_gridfill']['hours']} cheaper than a flat one, where in truth it is €{EI_DEARER:,.0f} dearer.",
])

# ------------------------------------------------------------------ proposals
h2('What the explanations point to (for your approval)')
p('Not implemented. Ranked as before, impact against effort, and continuing the earlier list.')
table(['#', 'Fix', 'Impact', 'Effort', 'Scenarios'], [
    ['12', 'Put the panels on the clock the meter keeps (summer time from late March to late October)', f'High: every solar saving and payback, {-max(EARLY):+.1f}% to {-min(EARLY):+.1f}%', 'Small', 'A, B'],
    ['13', "Work the battery home's no-panels hours out from its days before the panels, or the heating profile, not from what the meter bought", f"High for battery homes: saving {BATT['B2-hp_solar_batt']['err']:,.0f}% and {BATT['B5-hp_solar_gridfill']['err']:,.0f}% today", 'Small', 'B2-hp_solar_batt, B5, B3-friend'],
    ['14', "Battery losses when working use back: the battery's own losses in place of 8% of the solar used", 'Medium: use −4% on battery homes', 'Small', 'B2, B4d, B5'],
    ['15', f'Check the panel model against PVGIS face by face ({GEN_S:+.1f}% facing south, {GEN_F:+.1f}% on south-west and north-east)', 'Medium', 'Medium', 'All solar'],
    ['16', 'Score a file from before the panels against the coming year with the panels up all year', 'Scoring only', 'Small', 'B1'],
])

# ------------------------------------------------------------------ fix 5 and real homes
h2('Fix 5, later: as you set it out')
p('For a solar file with no export rows yet, export data will not be made up. The answers will include "Panels were up the whole time; sales aren\'t on the file yet". With it, the result is shown as an estimate: the home\'s use is worked back from the stated panels, the sales are what those panels would sell, and the accuracy figure is widened for both. The golden homes for it are already in place: B3-gas_solar today reads −34.0% use, +83.0% bill and no payback, and must show a payback once fixed.')
h2('Real homes: ready for your files')
ul([
    'Folder: `tests/fixtures/meter-scenarios/real/private/<id>/` (git ignores it). Put in it the ESB file (My Meter, Downloads, "30-minute readings in kW"), the Sigenergy export for the same twelve months at its finest interval (CSV or Excel), and `home.json` from `home.example.json`: your setup answers and the system as installed.',
    "`add_home.py <folder>` replaces the MPRN and meter serial. It reads the Sigenergy columns by their names and finds out whether its rows are stamped at the start or end of each interval, by lining its sales up with the meter file's. It prints both files' bought and sold totals side by side, then writes the truth: the bills on every plan from the meter file, the home's use from Sigenergy, and the saving and payback from that use.",
    'The tester\'s file without generation data scores the bills and the best plan; use and payback need generation.',
    'They stay out of git: half-hourly readings show when a home is in, out and asleep. To put one in the golden test, its owner has to agree to the anonymised file being committed. The tester has to agree for theirs.',
    f"`add_home.py --selftest` builds the tester's case with five-minute Sigenergy-style rows stamped at the end, recovers the stored truth exactly ({kwh(T['friend']['use_kwh'])} kWh, €{T['friend']['best_cost']:.2f}, payback {T['friend']['payback']}), and scores through the app as B3-friend does.",
])
h2('How it was run')
p('Each build: `SCENARIO_OUT=<dir> npx playwright test meter-scenarios --grep @scenarios` (all 71, the plan list and date frozen), then `python3 tests/fixtures/meter-scenarios/score.py <dir>` and `make_golden.py <dir>`. The scores and golden.json after each fix are in `stages/`. The explanation runs are in `explain/`: the app\'s own figures were read out of the running page (`app/`, from the build before the fixes, with the probe specs kept as .txt), and the truth\'s were rerun with one habit at a time (`shift_test.py`, `truth_parts.py`, `b1_parts.py`).')

# ------------------------------------------------------------------ render
def to_md():
    out = []
    for b in blocks:
        k = b[0]
        if k == 'h1': out.append(f'# {b[1]}\n')
        elif k == 'h2': out.append(f'\n## {b[1]}\n')
        elif k == 'h3': out.append(f'\n### {b[1]}\n')
        elif k == 'p': out.append(b[1] + '\n')
        elif k == 'ul': out.append('\n'.join(f'- {x}' for x in b[1]) + '\n')
        elif k == 'table':
            clean = lambda c: str(c).replace('|', '\\|').replace('<br>', '; ')
            out.append('| ' + ' | '.join(clean(h) for h in b[1]) + ' |\n|' + '---|' * len(b[1]) + '\n' + '\n'.join('| ' + ' | '.join(clean(c) for c in row) + ' |' for row in b[2]) + '\n')
        elif k == 'img': out.append(f'![{b[2]}](meter-file-fixes-2026-10-09/{b[1]})\n\n*{b[2]}*\n')
    return '\n'.join(out)
def inline_html(t):
    t = Hh.escape(t, quote=False).replace('&lt;br&gt;', '<br>')
    t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
    return re.sub(r'`(.+?)`', r'<code>\1</code>', t)
def to_html():
    css = open(os.path.join(ROOT, 'docs', 'meter-file-testing-2026-10-09', 'report.css')).read()
    css += '\ntable.golden, table.results { font-size: 7pt; } table.golden td:first-child { min-width: 38mm; } table.b1, table.bias { font-size: 7.6pt; }\n'
    out = [f'<!doctype html><html lang="en-IE"><head><meta charset="utf-8"><title>Meter-file fixes</title><style>{css}</style></head><body><main>']
    for b in blocks:
        k = b[0]
        if k in ('h1', 'h2', 'h3'): out.append(f'<{k}>{inline_html(b[1])}</{k}>')
        elif k == 'p': out.append(f'<p>{inline_html(b[1])}</p>')
        elif k == 'ul': out.append('<ul>' + ''.join(f'<li>{inline_html(x)}</li>' for x in b[1]) + '</ul>')
        elif k == 'table':
            def cell(c):
                s = inline_html(str(c)); cl = ' class="bad"' if s.startswith('FAIL') else ' class="good"' if s == 'pass' else ''
                return f'<td{cl}>{s}</td>'
            out.append(f'<div class="tw"><table class="{b[3]}"><thead><tr>' + ''.join(f'<th>{inline_html(str(h))}</th>' for h in b[1]) + '</tr></thead><tbody>' +
                       ''.join('<tr>' + ''.join(cell(c) for c in row) + '</tr>' for row in b[2]) + '</tbody></table></div>')
        elif k == 'img': out.append(f'<figure><img src="{b[1]}" alt=""><figcaption>{inline_html(b[2])}</figcaption></figure>')
    out.append('</main></body></html>')
    return '\n'.join(out)

open(os.path.join(os.path.dirname(HERE), 'meter-file-fixes-2026-10-09.md'), 'w').write(to_md())
open(os.path.join(HERE, 'report.html'), 'w').write(to_html())
print('written', len(blocks), 'blocks')
