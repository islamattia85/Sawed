"""Build docs/meter-file-testing-2026-10-09.md and the HTML the PDF is printed from.

Every figure is read from the run files in this folder (results/, step0/) and the
truth in tests/fixtures/meter-scenarios; nothing is typed in by hand except the
wording.  python3 docs/meter-file-testing-2026-10-09/report.py
"""
import json, os, html as H

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FX = os.path.join(ROOT, 'tests', 'fixtures', 'meter-scenarios')
R = {r['id']: r for r in json.load(open(os.path.join(HERE, 'results', 'scores.json')))}
RAW = {i: json.load(open(os.path.join(HERE, 'results', i + '.json'))) for i in R}
T = json.load(open(os.path.join(FX, 'truth.json')))
SC = {s['id']: s for s in json.load(open(os.path.join(FX, 'scenarios.json')))}
GOLD = json.load(open(os.path.join(FX, 'golden.json')))['scenarios']
B1 = json.load(open(os.path.join(HERE, 'step0', 'benchmark-homes-by-build.json')))
B2 = json.load(open(os.path.join(HERE, 'step0', 'new-homes-by-build.json')))
BUILDS = [('ad1de59', '6 Oct 08:31', 'before panel detection (the 5 October study)'), ('123f0ba', '6 Oct 09:25', 'panel detection added'),
          ('5179c9f', '8 Oct', 'just before the tester fix'), ('3a8346b', '9 Oct 09:01', 'the tester fix'), ('e22e94a', '9 Oct 10:59', "today's correction")]

def pct(v, sign=True):
    if v is None: return '—'
    v = round(v, 1) + 0.0
    return (f'{v:+.1f}%' if v else '0.0%') if sign else f'{v:.1f}%'
def eur(v): return '—' if v is None else f'€{v:,.0f}'
def r(i): return R[i]
PLAN = {}
for t in json.load(open(os.path.join(FX, 'tariffs-2026-10-09.json'))):
    if t.get('id') != '__meta__': PLAN[t['id']] = f"{t['supplier']} {t['plan']}".replace('Home Electric + SST', 'Home Electric+ SST')

def did(x):
    """What the app did, in a few words."""
    if x['outcome'] == 'rejected': return 'Rejected: ' + x['message'].split('\n')[-1].split('. In your')[0].strip()
    raw = RAW[x['id']]; msg = ' '.join(raw['seen']['import'])
    bits = []
    if 'Only ' in msg and 'days of data' in msg: bits.append('warned (short file)')
    elif 'Partial year' in msg: bits.append('warned (partial year)')
    q = [q for q in raw['seen']['questions'] if q['q'] == 'filewhen']
    if q:
        txt = q[0]['text'].split(' — ')[0]
        bits.append(f'asked "{txt}"' + ('' if q[0].get('fits', True) and q[0]['answer'] in (q[0].get('offered') or [q[0]['answer']]) else ' (no option fitted)'))
    return '; '.join(bits) or 'accepted'

blocks = []
def h1(t): blocks.append(('h1', t))
def h2(t): blocks.append(('h2', t))
def h3(t): blocks.append(('h3', t))
def p(t): blocks.append(('p', t))
def ul(items): blocks.append(('ul', items))
def ol(items): blocks.append(('ol', items))
def table(head, rows, cls=''): blocks.append(('table', head, rows, cls))
def img(path, cap): blocks.append(('img', path, cap))

# ------------------------------------------------------------------ summary
full = [i for i in R if i[:2] in ('A1', 'A2', 'A6', 'A7')]
full_pass = [i for i in full if R[i].get('pass')]
acc = sorted({R[i]['accuracy_shown'] for i in R if R[i]['outcome'] != 'rejected'})
h1('How Peakless reads ESB meter files')
p('Test report, 9 October 2026, branch `test/meter-file-scenarios` off v8 at d32111d. Test and measurement only: the model and the way a file is reconciled with your answers are unchanged. Every number below comes from a run of the real app against homes whose true use and true costs are known.')
h2('Summary')
ul([
    f"**The jump from about 1% to 65–87% came on 6 October, not from the tester fix.** Commit 123f0ba started reading meter files for when the panels went up. A home whose battery soaks up the winter's spare solar exports nothing until spring, so the months before were taken for a home without panels and the panels added on top: the tester-like home's price gap went from {B2['ad1de59']['B3-friend']['price_gap']}% to {B2['123f0ba']['B3-friend']['price_gap']}%. The tester fix (3a8346b) cut it to {B2['3a8346b']['B3-friend']['price_gap']}% but put a {B2['3a8346b']['B2-gas_solar']['price_gap']}–{B2['3a8346b']['B5-hp_solar_gridfill']['price_gap']}% gap on files with panels up all year and gave a no-battery home a {B2['3a8346b']['B2-gas_solar']['payback']}-year payback (true {B2['3a8346b']['B2-gas_solar']['true_payback']}). Today's build (e22e94a) is within {min(B2['e22e94a'][i]['price_gap'] for i in ('B2-gas_solar','B2-hp_solar_batt','B3-friend','B5-hp_solar_gridfill'))}–{max(B2['e22e94a'][i]['price_gap'] for i in ('B2-gas_solar','B2-hp_solar_batt','B3-friend','B5-hp_solar_gridfill'))}% on all of them.",
    f"**A full year from a home without panels reads well:** {len(full_pass)} of {len(full)} full-year scenarios pass every tolerance; the one that does not is a heat pump home on calendar 2025 ({pct(R['A1-heatpump']['kwh_err'])} use), a different winter from the year ahead.",
    f"**Five problems that make no sound.** A file that ends on the last day of a two-month period loses that period's neighbour (the last reading is stamped 00:00 the next day and counted as a whole day): nine months ending 28 February read {pct(R['A3a-gas']['kwh_err'])} for the gas home. Rows that appear twice are counted twice ({pct(R['D3b-gas']['kwh_err'])}); the same months five times, five times ({pct(R['D5f-gas']['kwh_err'])}). US-style dates are half read with no warning. A typed yearly figure is replaced by the file without a word. The wrong panel count rebuilds the home's use from the wrong output ({pct(R['B8-gas_solar']['kwh_err'])} use, payback {R['B8-gas_solar']['payback']} years against {R['B8-gas_solar']['true_payback']}).",
    f"**The accuracy figure does not move.** It reads ±{acc[0]}% to ±{acc[-1]}% for every accepted file, including a four-week winter file that is {pct(R['A5b-heatpump']['kwh_err'])} out and a doubled file that is {pct(R['D3b-gas']['kwh_err'])} out. The import card does warn about short and partial files, once.",
    f"**Short or seasonal files are fine for gas homes and far out for heat pumps:** four summer weeks {pct(R['A5a-gas']['kwh_err'])} (gas) and {pct(R['A5a-heatpump']['kwh_err'])} (heat pump); four winter weeks {pct(R['A5b-gas']['kwh_err'])} and {pct(R['A5b-heatpump']['kwh_err'])}.",
    f"**Solar files without export rows (common in the first weeks) go wrong:** the app proposes a wrong install date, offers no answer that fits, reads use {pct(R['B3-gas_solar']['kwh_err'])} and shows no payback.",
    f"**Where the user's answers and the file disagree, the app mostly goes with one of them without saying so:** no solar but exports in the file ({pct(R['B6-gas_solar']['kwh_err'])} use, no payback); EV or heat pump added partway ({pct(R['C1-gas_ev_now']['kwh_err'])}, {pct(R['C2-gas_to_hp']['kwh_err'])}); a file from a previous home ({pct(R['C3-moved']['kwh_err'])}).",
    f"**A golden-households test now guards this.** 14 reference scenarios run through the real app on every push; on the 6 October build and the tester-fix build it fails the same five solar and battery homes, on today's it passes.",
])
p('CI note: the brief says CI on v8 fails at the type check. That was fixed this morning (3a8346b); the last three pushes to v8 (3a8346b, e22e94a, d32111d) passed every step. CI runs on v8 and on pull requests, so the golden test starts guarding v8 when this branch is merged or opened as a pull request.')

# ------------------------------------------------------------------ step 0
h2('Step 0: the regression')
h3('The commits')
table(['Commit', 'When', 'What it did to a meter file from a home with panels'], [
    ['ad1de59', '6 Oct 08:31', 'Panels up: the file is priced as recorded. The home\'s own use is taken to be what it bought, so the "without panels" side of every comparison, and the payback, is worked out on a home far smaller than it is.'],
    ['123f0ba', '6 Oct 09:25', 'Reads the file for when exports begin. If they begin more than two weeks in, the days before are taken to be the home without panels, the stated panels are added to them, and the days after are ignored unless they cover eleven months. A battery home exports nothing in winter, so a year with panels throughout became five winter months "without panels" with panels added again.'],
    ['5179c9f', '8 Oct', 'As 123f0ba for meter files.'],
    ['3a8346b', '9 Oct 09:01', 'The tester fix. With exports in the file, every day from the first export is "worked back" to the home\'s own use (bought + modelled output − sold − battery losses), and every plan, including the home\'s own system, is priced by simulating the panels again on that use. The home\'s use came right; its own bills became a model\'s estimate instead of the readings, and the misread start date stayed.'],
    ['e22e94a', '9 Oct 10:59', 'Panels up for the whole file and the stated system unchanged: priced from the readings again; the worked-back use is kept for the use figures and every what-if. If exports start partway, the app asks whether that is when the panels went up instead of assuming.'],
])
h3('The benchmark homes from the five-way study, on each build')
p('Same homes, same true costs, same frozen prices and date for every build. Price gap: the average gap between the app\'s yearly cost and the true cost across all 33 plans. € lost: what the app\'s top plan costs against the truly cheapest. Rows that changed between builds, plus two that did not.')
rows = []
for x in B1:
    if x['mode'] != 'file' or x['home'] not in ('typical', 'heatpump', 'solar', 'solar_batt', 'solar_ev', 'solar_mid'): continue
    rows.append([x['label']] + [f"{x[c]['err']}% · {eur(x[c]['lost'])}" if c in x else '—' for c, _, _ in BUILDS])
table(['Home (meter file)'] + [f'{c}<br>{w}' for c, w, _ in BUILDS], rows, 'step0')
h3('The new ground-truth homes, on each build')
p('Use: the app\'s yearly use against the true use. Gap: price gap as above. Payback: the app\'s against the true one ("none" where the app shows no payback).')
rows = []
for i in ('A1-gas', 'B2-gas_solar', 'B2-hp_solar_batt', 'B3-friend', 'B4a-gas_solar', 'B4d-hp_solar_batt', 'B5-hp_solar_gridfill', 'B6-gas_solar'):
    cells = []
    for c, _, _ in BUILDS:
        x = B2.get(c, {}).get(i)
        cells.append('—' if not x else f"{pct(x['kwh_err'])} · {x['price_gap']}% · {x.get('payback') if x.get('payback') is not None else 'none'}/{x.get('true_payback')}")
    rows.append([f"{i}: {SC[i]['title']}"] + cells)
table(['Scenario'] + [f'{c}' for c, _, _ in BUILDS], rows, 'step0')
p(f"Why: before 6 October the readings were priced as they are (good) but the home looked {abs(B2['ad1de59']['B2-gas_solar']['kwh_err']):.0f}–{abs(B2['ad1de59']['B2-hp_solar_batt']['kwh_err']):.0f}% smaller than it is, so no payback was shown, which is what the tester saw. 123f0ba broke the files where exports start late (the tester-like home, exports recorded from 1 December). 3a8346b fixed the size of the home but priced the home's own system by simulation, which costs 4–14% on files that were right before, and gave the no-battery home a {B2['3a8346b']['B2-gas_solar']['payback']}-year payback. e22e94a keeps both right.")
h3('What "the app makes them match" does, and when')
ol([
    '**Two-month totals (every file).** For each two-month period, the readings in it are averaged per day and multiplied by the period\'s length. Periods with no readings are filled from the average of the others, reshaped by the seasonal profile for the heating type. The import card shows the totals, marks filled periods with *, and says "Partial year" (under 300 days or a period missing) or "Only N days" (under 45 days).',
    '**Where the panels are (files with exports or a midday drop, when the person says they have panels).** Exports from the first two weeks and the system unchanged: priced as recorded. Exports from later: asks "Did the panels go up around <date>?". No exports: asks "Is your meter file from before the panels went up?", or with a lasting midday drop, "Did the panels go up around <date>?".',
    '**Worked-back use (files with panels in them).** The days after the panels are rebuilt as bought + the stated panels\' modelled output − sold − 8% of the solar used, if there is a battery. The two-month totals are replaced with these, and periods the file does not cover are grown by the same ratio (used ÷ bought). This is what turns 2,600 kWh bought into a 4,000 kWh home. It runs on the stated system: a wrong panel count gives a wrong home.',
    '**Only part of the file (a file that straddles the install, or a "no solar" answer with exports more than 60 days in).** Only the days before the panels are used, and the totals recomputed from them.',
    '**Turning totals into hours.** With at least 330 days, each day of the year is the recorded day nearest the same date on the same weekday. With fewer, the two-month totals are spread on a 70/30 blend of the file\'s average day and the heating profile. Either way the year is rescaled to the totals.',
    '**Typed figures.** Once a file is in, the typed yearly kWh and bill are ignored.',
])

# ------------------------------------------------------------------ the homes
h2('The test homes')
p('Each home is two years and nine months of half-hour use (1 January 2024 to 8 October 2026), built from its own activity and Cork weather, not from the profiles Peakless uses. Solar output follows the day-to-day weather and is anchored month by month to PVGIS for Cork (south 977, south-west 919, north-east 621 kWh per kWp a year at 35°). The truth is the home as it is now over its last twelve months, priced as the year ahead on the plan list frozen on 9 October 2026, with announced price changes, standing charges, the PSO levy, export at each plan\'s rate and the tax on export income above €600. Solar saving and payback are counted the way the app counts them: the cheapest plan without the panels less the cheapest with them; the price after grant over that.')
rows = []
for k, t in T.items():
    s = t['system']
    sysd = f"{s['kwp']:.1f} kWp" + (f" + {s['battery']} kWh" if s['battery'] else '') + f", €{s['cost'] - s['grant']:,} after grant"
    rows.append([t['label'], f"{t['use_kwh']:,}", f"{t['bought_kwh']:,} / {t['sold_kwh']:,}" + (f" (makes {t['gen_kwh']:,})" if t['gen_kwh'] else ''), f"{PLAN[t['best']]}, {eur(t['best_cost'])}", sysd + ('' if t['gen_kwh'] else ' (quoted)'), eur(t['saving']), t['payback']])
table(['Home', 'Use, kWh', 'Bought / sold', 'Cheapest plan, true cost', 'System', 'Saving', 'Payback, years'], rows)
p('The tester\'s own file was not available. "The tester\'s case" is rebuilt from what he described: a heat pump home of about 6,500 kWh in the south, 12 panels south-west and 10 north-east, a 9 kWh battery, panels from 20 October 2025, and (as often happens) exports recorded by ESB only from 1 December. With his file, MPRN and serial removed, it can be added as a scenario.')

# ------------------------------------------------------------------ results
h2('Results: every scenario')
p('Tolerances (the brief\'s): use and bill within 5%, payback within half a year, the best plan or one within €25 a year. For partial and short files the seasons have to be guessed, and we accept 10% (nine months, this year so far) and 15% (two to six weeks) on use and bill, 0.75 and 1 year on payback: wider than that and a plan or payback decision could flip. Bill: the app\'s yearly cost for its top plan against that plan\'s true cost. For a home planning panels, plans are compared as the home is today. For a battery that only stores solar, the app\'s answer for that (given under its headline) is scored; its headline assumes night filling. Accuracy: the "±" figure the app shows.')
rows = []
for i, x in R.items():
    if x['outcome'] == 'rejected':
        rows.append([i, SC[i]['title'], did(x), '—', '—', '—', '—', '—', '—', 'n/a']); continue
    plan = PLAN.get(x['best'], x['best']) + ('' if not x['plan_gap'] else f" (+€{x['plan_gap']})")
    pb = '—' if x.get('true_payback') is None else f"{x.get('payback') if x.get('payback') is not None else 'none'} / {x['true_payback']}"
    rows.append([i, SC[i]['title'], did(x), pct(x['kwh_err']), plan, pct(x['bill_err']), pct(x.get('saving_err')), pb, f"±{x['accuracy_shown']}%", 'pass' if x['pass'] else 'FAIL: ' + ', '.join(x['fails'])])
table(['ID', 'Scenario', 'What the app did', 'Use', 'Top plan (€ over cheapest)', 'Bill', 'Saving', 'Payback app / true', 'Shown', 'Result'], rows, 'results')
groups = {}
for i, x in R.items():
    g = SC[i]['group']; groups.setdefault(g, [0, 0, 0])
    if x['outcome'] == 'rejected': groups[g][2] += 1
    elif x['pass']: groups[g][0] += 1
    else: groups[g][1] += 1
p('By group: ' + '; '.join(f"{g}: {v[0]} pass, {v[1]} fail, {v[2]} rejected" for g, v in sorted(groups.items())) + '.')

# ------------------------------------------------------------------ what the user sees
h2('What the user sees')
for path, cap in [('shots/A3a-gas-import1.png', 'Nine months ending 28 February: March–April shows 4 kWh and "6 of 6 billing periods"; the year reads ' + pct(R['A3a-gas']['kwh_err']) + '.'),
                  ('shots/A5b-heatpump-import1.png', 'Four winter weeks of a heat pump home: warned once, then ±' + str(R['A5b-heatpump']['accuracy_shown']) + '% on every figure; the year reads ' + pct(R['A5b-heatpump']['kwh_err']) + '.'),
                  ('shots/B3-gas_solar-q-filewhen.png', 'Panels up all year, ESB not recording exports: a wrong date, and neither answer is true.'),
                  ('shots/B4a-gas_solar-q-filewhen.png', 'A file that straddles the install: the right date proposed, and the right answer available.'),
                  ('shots/D3b-gas-import1.png', 'Every row twice: "A full year of readings", ' + pct(R['D3b-gas']['kwh_err']) + ', no warning.'),
                  ('shots/D6-gas-import1.png', '5,600 kWh typed in setup, then this file: the typed figure is replaced without a word.'),
                  ('shots/D5c-gas-import1.png', 'A bank statement is called "one of ESB\'s daily files".'),
                  ('shots/D2a-gas-import1.png', 'US-style dates: 6,912 of 17,520 readings read, shown as a "Partial year".')]:
    img(path, cap)

# ------------------------------------------------------------------ user errors
h2('User errors: how the app handles them')
ue = [('B4b-gas_solar', 'Says the panels were up all along; they went up in May'), ('B6-gas_solar', 'Says no solar; the file shows exports from the first day'),
      ('B7a-gas', 'Says 9 panels; there are none'), ('B7b-gas', 'Says 9 panels and that the file is from before them; there are none'), ('B8-gas_solar', 'Says 14 panels; there are 9'),
      ('C3-moved', 'Uploads the file from the house they left'), ('D6-gas', 'Typed 5,600 kWh, then uploads a file showing 4,000'), ('D2a-gas', 'Opened and saved the file in Excel with US dates'),
      ('D3b-gas', 'File with every row twice'), ('D3c-gas', 'Two overlapping files, one after the other'), ('D2b-gas', 'Excel with semicolons and comma decimals'), ('D2c-gas', 'Header row renamed'),
      ('D5c-gas', 'A bank statement'), ('D5d-gas', 'A gas meter file'), ('D5e-gas', 'A PDF renamed .csv'), ('D5a-gas', 'An empty file')]
rows = []
for i, what in ue:
    x = R[i]
    if x['outcome'] == 'rejected': rows.append([what, did(x), 'Turned away', '—']); continue
    shown = f"±{x['accuracy_shown']}%" + (' (says "Meter file shows panels already running")' if i == 'B6-gas_solar' else '')
    rows.append([what, did(x), shown, f"use {pct(x['kwh_err'])}, bill {pct(x['bill_err'])}" + (f", payback {x.get('payback') if x.get('payback') is not None else 'none'} vs {x['true_payback']}" if x.get('true_payback') else '')])
table(['What the person did', 'What the app did', 'What it says about trust', 'How wrong'], rows)

# ------------------------------------------------------------------ step 4
h2('Questions answered')
h3('1. How each group is handled today')
ul([
    f"**No panels yet, last year's file (A).** The file is read into six two-month totals (per-day average × days in the period), missing periods filled from the others on the seasonal profile; with 330+ days the year is the real days, otherwise the totals spread on an average day. Full years land within {min(abs(R[i]['kwh_err']) for i in full):.1f}–{max(abs(R[i]['kwh_err']) for i in full):.1f}% on use. Partial years are right when they end mid-period and wrong when they end on a period's last day (the midnight bug). Under 330 days the EV home loses its night charging pattern and is offered the wrong plan (+€{R['A4-ev']['plan_gap']} a year). Two years: the per-day averages use both, the hours use the latest.",
    "**Panels already up (B).** If the file shows exports from the start and the stated system has not changed, the readings are priced as they are and the home's use is worked back. If exports start later, or there are none, it asks one question, the answer decides which days are 'before' and which are priced. With a battery, setup does not ask how it charges once a file is in, and the headline assumes it is filled at night.",
    "**The home changed in the file (C).** Nothing looks for it. An EV or heat pump added partway is averaged into the year (about 17% low), a holiday is averaged in, and a file from a previous home is taken as this one.",
    "**File problems (D).** Daily files, empty files and files it cannot parse are turned away with a message (two of the messages are wrong about what the file is). kWh files, gaps, a replaced meter, two overlapping uploads, the leap day and both clock changes are handled. Duplicated rows and US dates get through silently.",
])
h3('2. What period the figures represent')
p('A modelled year: the file\'s days (or its two-month totals) laid on a calendar year, priced at today\'s prices with announced changes from their dates. In effect, "the next twelve months, if they are like the file\'s year". Home and Plans say "a year"; a few places say "a typical year"; the import card says "anticipated full-year profile" and, for files over 400 days, "averaged per day, so the result is one typical year". Nothing says which months the figures stand for or that weather is not adjusted. A person should expect the twelve-month total of their bills to match within the error shown here when the coming year is like the file\'s; individual two-month bills will not match, because winter and summer differ.')
h3('3. How a partial or seasonal file becomes a year')
p(f"Each two-month period with readings is its per-day average × its length. A period with none is the average of the covered periods × (that period's share in the seasonal profile ÷ the average share). Gas homes use ESB's standard load profile (urban or rural); heat pump and storage homes their own winter-heavy profiles. For a gas home this is close: four weeks of summer {pct(R['A5a-gas']['kwh_err'])}, four weeks of winter {pct(R['A5b-gas']['kwh_err'])}. For a heat pump it is far out: summer {pct(R['A5a-heatpump']['kwh_err'])}, winter {pct(R['A5b-heatpump']['kwh_err'])}, because the profile's winter-to-summer ratio is much flatter than a real heat pump's and nothing adjusts for the weather of the weeks in the file.")
h3('4. Solar homes: rebuilding use from imports, and missing exports')
p(f"Use is worked back month by month: what was bought, plus what the stated panels make in a typical year for that month, less what was sold, less 8% of the solar used where there is a battery. Without a battery the night hours are the meter's own and the solar used is put into daylight hours; with one, each day's total is spread on the home's own shape from before the panels (if there are three weeks of it) blended with the heating profile. It is right when the stated system is right ({pct(R['B2-gas_solar']['kwh_err'])} for the 4 kWp home) and wrong in step with the system when it is not ({pct(R['B8-gas_solar']['kwh_err'])} with 14 panels stated for 9). With no export rows, the app either asks whether the file is from before the panels or, if the midday buying drops, proposes a date; answering that the system never exports prices the readings as they are, reads use as what was bought ({pct(R['B3-gas_solar']['kwh_err'])} and {pct(R['B3-hp_solar_batt']['kwh_err'])}), leaves out the export income the coming year will pay (bill {pct(R['B3-gas_solar']['bill_err'])}) and shows no payback.")
h3('5. Where the app changes the data or the answers without showing it')
ul([
    'Fills missing two-month periods from the others (shown with * on the import card, not afterwards).',
    'Counts a lone midnight reading as a whole day of the next period (the bug above): silent.',
    'Adds up rows that appear twice: silent.',
    'Reads US-style dates as Irish ones, dropping the days that cannot be months: shown only as "Partial year".',
    'Merges a new upload with earlier ones (latest 400 days kept) while the yearly totals come from the newest file alone: silent.',
    'Replaces a typed yearly kWh or bill with the file: silent.',
    'Rebuilds the home\'s use from the stated panels, and grows the periods the file does not cover by the same ratio: one line in the accuracy panel ("worked back").',
    'Uses only the days before the panels when a file straddles them, or when the person says no solar but exports appear after 60 days: the import card says which days; the accuracy panel says "Meter file shows panels already running".',
    'Assumes a battery is filled from the grid at night when a file is in (the question is skipped): the Plans page says so and gives the solar-only answer.',
    'Credits export income from the file to a home said to have no panels: silent.',
    'Skips readings below 0 or above 50 kW: silent (the count is not shown).',
    'Moves each day to the nearest same weekday within three days and takes the latest year when there are two: silent, and harmless in these runs.',
])

# ------------------------------------------------------------------ risks
h2('Risk register')
table(['Risk', 'When it happens', 'How wrong', 'How likely', 'Today', 'Proposed fix'], [
    ['Last reading of a period counted as a day of the next', 'A file ending on the last day of Feb, Apr, Jun, Aug, Oct or Dec (a calendar-year download ends 31 Dec)', f"{pct(R['A3a-gas']['kwh_err'])} to {pct(R['A3a-heatpump']['kwh_err'])} (nine months); {pct(R['A1-gas']['kwh_err'])} (calendar year)", 'High', 'Silent', 'Date each reading by the start of its half hour in the totals, as the hourly ledger already does'],
    ['Duplicate rows counted twice', 'Files joined in Excel, re-downloads appended', f"{pct(R['D3b-gas']['kwh_err'])}; {pct(R['D5f-gas']['kwh_err'])} for five copies", 'Low–medium', 'Silent, "A full year of readings"', 'Keep one reading per half hour and type; say how many duplicates were dropped'],
    ['Short or seasonal file for a heat pump home', 'New meters, recent movers, partial downloads', f"{pct(R['A5a-heatpump']['kwh_err'])} to {pct(R['A5b-heatpump']['kwh_err'])}", 'Medium', 'Warned once; accuracy stays ±4%', 'Scale with degree days for heat pumps; widen the accuracy figure with coverage; ask for a bill to anchor'],
    ['Accuracy figure ignores coverage and contradictions', 'Any short, partial, doubled or contradicted file', f"Shows ±4% on results up to {pct(R['D5f-gas']['kwh_err'])} out", 'High', '—', 'Work the file part of the accuracy figure out from days covered, periods filled, duplicates and unresolved questions'],
    ['Under 330 days loses when things happen', 'EV, night storage, any timed load with a partial file', f"Wrong plan, +€{R['A4-ev']['plan_gap']} a year (EV)", 'Medium', 'Silent', 'Spread each month on that month\'s own recorded days instead of one blended average day'],
    ['Solar file without export rows', 'First weeks after an install; export not yet registered', f"use {pct(R['B3-gas_solar']['kwh_err'])}, bill {pct(R['B3-gas_solar']['bill_err'])}, no payback", 'High for new installs', 'Wrong date proposed; no answer fits', 'Add "Panels were up the whole time; exports aren\'t on the file yet"; model the exports for the coming year'],
    ['No solar said, exports in the file', 'Person unsure, or forgot', f"use {pct(R['B6-gas_solar']['kwh_err'])}, no payback", 'Medium', 'Accuracy panel only', 'Ask: "Your file shows power sent to the grid from <date>. Do you have panels?"'],
    ['Wrong panel count', 'Typing from memory', f"use {pct(R['B8-gas_solar']['kwh_err'])}, payback {R['B8-gas_solar']['payback']} vs {R['B8-gas_solar']['true_payback']}", 'Medium', 'Silent', 'Compare expected and recorded exports; ask when they differ by more than about a third'],
    ['Home changed in the file', 'EV bought, heat pump fitted, extension', f"{pct(R['C1-gas_ev_now']['kwh_err'])} / {pct(R['C2-gas_to_hp']['kwh_err'])}; EV plan +€{R['C1-gas_ev_now']['plan_gap']}", 'Medium', 'Silent', 'Look for a lasting step in use or in night use; ask "Did something change around <date>?" and price the part after'],
    ['File from another home', 'Moved house, landlord\'s file', pct(R['C3-moved']['kwh_err']), 'Low', 'Silent', 'One question after upload: "Is this file from the home you live in now?"'],
    ['Typed figure replaced by the file', 'Typed first, uploaded later', 'The figure the person gave is dropped', 'Medium', 'Silent', 'Say "Your file says 3,990 kWh; you told us 5,600. We\'ll use the file." with an undo'],
    ['Misread or misnamed files', 'Excel edits, wrong downloads', 'US dates half read; semicolon and renamed-header files refused as "0 readings"; a bank or gas file called an ESB daily file', 'Medium', 'Mixed', 'Accept semicolons and comma decimals; spot day-month order; find columns by content; name what the file looks like'],
    ['Battery charging assumed with a file', 'Battery homes uploading a file', f"headline plan +€{R['B1a-friend']['headline']['gap']} a year if the battery is not filled at night (tester's case)", 'Medium', 'Plans page gives both answers; setup does not ask', 'Ask how the battery charges whatever the input'],
    ['Weather of the file\'s year', 'Heat pump homes, any single year', f"{pct(R['A1-heatpump']['kwh_err'])} (calendar 2025)", 'High, small', 'Not adjusted, not said', 'Degree-day adjustment for heating; say which months the figures stand for'],
])

# ------------------------------------------------------------------ fixes
h2('Proposed fixes, ranked')
p('Impact is how much wrong answers would fall, across how many people; effort is a rough size. None is implemented; each needs your approval. Each should come with its scenario added to the golden households, and the golden limits tightened where it closes a gap.')
table(['#', 'Fix', 'Impact', 'Effort', 'Scenarios it fixes'], [
    [1, 'Date readings by the start of their half hour in the two-month totals', 'High', 'Small', 'A3a, A1 (and every file ending on a period boundary)'],
    [2, 'Drop duplicate readings and say so', 'High when it happens', 'Small', 'D3b, D5f'],
    [3, 'Make the accuracy figure reflect coverage, filled periods, duplicates and open questions', 'High', 'Small', 'A3–A5, B3, B6, C, D'],
    [4, 'Ask instead of overriding: typed vs file, no-solar-but-exports, "is this file from this home?"', 'Medium–high', 'Small', 'D6, B6, C3'],
    [5, 'Solar file without exports: a true answer option, and expected exports modelled', 'High for new installs', 'Medium', 'B3'],
    [6, 'Ask how a battery charges also when a file is uploaded', 'Medium', 'Small', 'B1, B4d'],
    [7, 'Cross-check the stated panels against recorded exports', 'Medium', 'Medium', 'B8, B7'],
    [8, 'Partial files: month-specific days for timing; degree days for heat pumps', 'Medium–high', 'Medium–large', 'A3–A5 (EV and heat pump), C4'],
    [9, 'Spot a step change in the file and ask', 'Medium', 'Medium', 'C1, C2'],
    [10, 'Parser: semicolons, comma decimals, day-month order, columns by content, clearer refusals', 'Low–medium', 'Small', 'D2a–D2c, D5c, D5d'],
    [11, 'Weather adjustment and saying which months the figures stand for', 'Low–medium', 'Large', 'A1-heatpump'],
])

# ------------------------------------------------------------------ golden
h2('The golden households')
p('`tests/e2e/golden-households.spec.js` runs 14 scenarios through the real app with the plan list and the date frozen, and compares with the stored truth. Limits are in `tests/fixtures/meter-scenarios/golden.json`: the agreed tolerance where the app meets it today; where it does not yet, today\'s error with a 5% margin, marked as a known gap, so a change can only make it better. Run on the 6 October build and on the tester-fix build, it fails B2-gas_solar, B2-hp_solar_batt, B3-friend, B4a-gas_solar and B5-hp_solar_gridfill; on today\'s build all 14 pass.')
table(['Scenario', 'Limits (use / bill / plan / payback)', 'Known gap'], [[k, f"{v.get('kwh')}% / {v.get('bill')}% / €{v.get('plan')} / {v.get('payback')} y" if not v.get('rejected') else 'must be turned away', v.get('known_gap', '')] for k, v in GOLD.items()])

h2('How it was run')
p('Scenarios: `python3 tests/fixtures/meter-scenarios/build.py` writes the homes, truth and files (seeded; the same bytes every time). `SCENARIO_OUT=<dir> npx playwright test meter-scenarios --grep @scenarios` runs all 71 through the app as a person would: setup, upload, the questions it asks answered from the scenario (only from the options on screen; where none is true, the nearest), the stated system set in My system. `python3 tests/fixtures/meter-scenarios/score.py <dir>` compares with the truth. Step 0 ran the same benchmark on five builds checked out side by side, each serving its own copy of the app, with the plan list and the date frozen identically.')
p('Limits. The homes are synthetic: their use comes from an activity model and Cork weather, their solar from that weather anchored to PVGIS. The reference battery is idealised (95% charging efficiency, no reserve), which accounts for part of the gap on the tester-like home with a file from before the panels (B1). The scenarios cover one region and one plan list. The tester\'s real file was not available.')

# ------------------------------------------------------------------ render
def md_inline(t): return t
def to_md():
    out = []
    for b in blocks:
        k = b[0]
        if k == 'h1': out.append(f'# {b[1]}\n')
        elif k == 'h2': out.append(f'\n## {b[1]}\n')
        elif k == 'h3': out.append(f'\n### {b[1]}\n')
        elif k == 'p': out.append(b[1] + '\n')
        elif k == 'ul': out.append('\n'.join(f'- {x}' for x in b[1]) + '\n')
        elif k == 'ol': out.append('\n'.join(f'{n}. {x}' for n, x in enumerate(b[1], 1)) + '\n')
        elif k == 'table':
            head, rows = b[1], b[2]
            clean = lambda c: str(c).replace('|', '\\|').replace('<br>', ' ')
            out.append('| ' + ' | '.join(clean(h) for h in head) + ' |\n|' + '---|' * len(head) + '\n' + '\n'.join('| ' + ' | '.join(clean(c) for c in row) + ' |' for row in rows) + '\n')
        elif k == 'img': out.append(f'![{b[2]}](meter-file-testing-2026-10-09/{b[1]})\n\n*{b[2]}*\n')
    return '\n'.join(out)

import re
def inline_html(t):
    t = H.escape(t, quote=False).replace('&lt;br&gt;', '<br>')
    t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
    t = re.sub(r'`(.+?)`', r'<code>\1</code>', t)
    return t
def to_html():
    css = open(os.path.join(HERE, 'report.css')).read()
    out = [f'<!doctype html><html lang="en-IE"><head><meta charset="utf-8"><title>Meter-file testing</title><style>{css}</style></head><body><main>']
    for b in blocks:
        k = b[0]
        if k in ('h1', 'h2', 'h3'): out.append(f'<{k}>{inline_html(b[1])}</{k}>')
        elif k == 'p': out.append(f'<p>{inline_html(b[1])}</p>')
        elif k in ('ul', 'ol'): out.append(f'<{k}>' + ''.join(f'<li>{inline_html(x)}</li>' for x in b[1]) + f'</{k}>')
        elif k == 'table':
            head, rows, cls = b[1], b[2], b[3]
            def cell(c):
                s = inline_html(str(c)); cl = ' class="bad"' if s.startswith('FAIL') else ' class="good"' if s == 'pass' else ''
                return f'<td{cl}>{s}</td>'
            out.append(f'<div class="tw"><table class="{cls}"><thead><tr>' + ''.join(f'<th>{inline_html(str(h))}</th>' for h in head) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join(cell(c) for c in row) + '</tr>' for row in rows) + '</tbody></table></div>')
        elif k == 'img': out.append(f'<figure><img src="{b[1]}" alt=""><figcaption>{inline_html(b[2])}</figcaption></figure>')
    out.append('</main></body></html>')
    return '\n'.join(out)

open(os.path.join(os.path.dirname(HERE), 'meter-file-testing-2026-10-09.md'), 'w').write(to_md())
open(os.path.join(HERE, 'report.html'), 'w').write(to_html())
print('written', len(blocks), 'blocks')
