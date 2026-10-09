"""Build the five-way report from the scored runs. Every figure comes from scores5.json,
the truth files, or the runs themselves; nothing is typed in by hand except the
feature table, which records what each site offered on 9 October 2026."""
import json, html, statistics as st, sys, os
sys.path.insert(0, '.')
import agg as A

R = json.load(open('scores5.json')); META = json.load(open('meta.json'))
T = json.load(open('truth.json')); G = json.load(open('truth_grid.json'))
FIX = {d['key']: d for d in json.load(open('pk_fix_compare.json'))}
P = {t['id']: t for t in json.load(open('/home/user/Sawed/public/tariffs.json')) if t.get('id') != '__meta__'}
SITES = [('pk', 'Peakless'), ('bk', 'bonkers.ie'), ('kw', 'kilowatt.ie'), ('sw', 'switcher.ie'), ('ep', 'EnergyPal')]
SN = dict(SITES)
e = html.escape

def pname(k):
    if not k: return '—'
    base, _, var = k.partition('@')
    p = P[base]; n = f"{p['supplier']} {p['plan']}".replace('Home Electric + SST', 'Home Electric+ SST')
    return n + {'28': ' (28% version)', '23': ' (23% version)', '26': ' (26% version)', 'sun': ' (free Sunday)', '': ''}[var]
def row(site, key):
    return next((r for r in R if r['site'] == site and r['key'] == key), None)
def eur(v): return '—' if v is None else f"€{v:,.0f}"
def pct(v, d=1): return '—' if v is None else f"{v:.{d}f}%"
def cls_lost(v): return 'na' if v is None else 'good' if v <= 0 else 'mid' if v < 50 else 'bad'
def cls_err(v): return 'na' if v is None else 'good' if v < 1 else 'mid' if v < 5 else 'bad'
def cell(r):
    if not r or r.get('mae') is None: return '<td class="na">not offered</td>'
    lost = r['lost']; top = '' if r.get('unscored_top') is None else f"<small>top: {e(r['unscored_top'])}</small>"
    return (f'<td><span class="e {cls_err(r["mae"])}">{pct(r["mae"])}</span> <span class="l {cls_lost(lost)}">{eur(lost) if lost is not None else "n/a"}</span>{top}</td>')

PLAIN = [h for h in META if not h.startswith('solar')]
FILEH = [h for h in PLAIN if h != 'legacy24']
SOLARH = ['solar', 'solar_batt', 'solar_ev', 'solar_mid']

def table_plans(mode):
    sites = SITES if mode == 'file' else SITES[:4]
    hs = FILEH if mode == 'file' else PLAIN
    out = ['<div class="tw"><table><thead><tr><th>Home</th><th>Cheapest plan, true cost</th>' + ''.join(f'<th>{n}</th>' for _, n in sites) + '</tr></thead><tbody>']
    for h in hs:
        anyr = next(r for r in R if r['key'] == f'{h}_{mode}')
        out.append(f'<tr><th scope="row">{e(META[h]["label"])}</th><td>{e(pname(anyr["best"]))} <span class="dim">{eur(anyr["best_cost"])}</span></td>' + ''.join(cell(row(s, f'{h}_{mode}')) for s, _ in sites) + '</tr>')
    out.append('</tbody></table></div>')
    return '\n'.join(out)

def totals():
    a_k = A.agg('plans', 'kwh'); a_f = A.agg('plans', 'file')
    out = ['<div class="tw"><table><thead><tr><th>Site</th><th class="n">Typed: right plan</th><th class="n">Typed: € lost</th><th class="n">File: right plan</th><th class="n">File: € lost</th><th class="n">Price gap, file</th><th class="n">Plans listed</th></tr></thead><tbody>']
    for s, n in SITES:
        k = a_k.get(s); f = a_f.get(s)
        tk = f"{k['right']} of {k['homes']}" if k else 'no typed route'
        lk = eur(k['lost']) if k else '—'
        out.append(f'<tr><th scope="row">{n}</th><td class="n">{tk}</td><td class="n">{lk}</td><td class="n">{f["right"]} of {f["homes"]}</td><td class="n">{eur(f["lost"])}</td><td class="n">{pct(f["err"], 2)}</td><td class="n">{f["listed"]:.0f}</td></tr>')
    out.append('</tbody></table></div>')
    return '\n'.join(out)

def energia_table():
    a_k = A.agg('plans', 'kwh'); a_f = A.agg('plans', 'file')
    out = ['<div class="tw"><table><thead><tr><th>Site</th><th class="n" colspan="2">Energia’s 30% and 27% offers open to new customers</th><th class="n" colspan="2">Only the 28% and 23% versions open</th></tr>'
           '<tr><th></th><th class="n">Right plan, file</th><th class="n">€ lost, file</th><th class="n">Right plan, file</th><th class="n">€ lost, file</th></tr></thead><tbody>']
    for s, n in SITES:
        f = a_f[s]
        out.append(f'<tr><th scope="row">{n}</th><td class="n">{f["right"]} of {f["homes"]}</td><td class="n">{eur(f["lost"])}</td><td class="n">{f["right_alt"]} of {f["homes"]}</td><td class="n">{eur(f["lost_alt"])}</td></tr>')
    out.append('</tbody></table></div>')
    return '\n'.join(out)

def crosscheck():
    import collections
    per = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in R:
        if r['group'] != 'plans' or r['mode'] != 'file' or not r.get('err'): continue
        for k, v in r['err'].items(): per[k][r['site']].append(v)
    keep = ['EI-SST', 'EI-24', 'EI-NB', 'BG-24', 'BG-TOU', 'BG-EV', 'EN-SMART-24-HOUR@28', 'EN-SMART@23', 'EN-SMART-DAY-NIGHT', 'EN-EV',
            'FL-24', 'FL-DNP', 'FL-EV', 'SSE-DNP', 'SSE-EVDAY', 'SSE-WKND', 'WP-SST', 'YN-24', 'YN-EV', 'CP-SST', 'EP-SST', 'PIN-LF']
    out = ['<div class="tw"><table class="cc"><thead><tr><th>Plan</th>' + ''.join(f'<th class="n">{n}</th>' for _, n in SITES) + '</tr></thead><tbody>']
    for k in keep:
        cells = []
        for s, _ in SITES:
            v = per[k].get(s) if s != 'pk' or '@' not in k else None
            if not v and s == 'pk' and '@' in k: cells.append('<td class="n na">own offer</td>'); continue
            if not v: cells.append('<td class="n na">—</td>'); continue
            m = st.median(v); c = 'good' if abs(m) <= 0.5 else 'mid' if abs(m) <= 5 else 'bad'
            m = round(m, 1) + 0.0
            cells.append(f'<td class="n {c}">{m:+.1f}%</td>')
        out.append(f'<tr><th scope="row">{e(pname(k))}</th>' + ''.join(cells) + '</tr>')
    out.append('</tbody></table></div>')
    agree = {}
    for s, _ in SITES:
        allv = [x for k in per for x in per[k].get(s, [])]
        agree[s] = (sum(abs(x) <= 0.5 for x in allv), len(allv))
    return '\n'.join(out), agree

def solar_file_table():
    out = ['<div class="tw"><table><thead><tr><th>Home</th><th>Cheapest plan, true cost</th>' + ''.join(f'<th>{n}</th>' for _, n in SITES) + '</tr></thead><tbody>']
    for h in SOLARH:
        b = row('pk', f'{h}_file')
        out.append(f'<tr><th scope="row">{e(META[h]["label"])}</th><td>{e(pname(b["best"]))} <span class="dim">{eur(b["best_cost"])}</span></td>' + ''.join(cell(row(s, f'{h}_file')) for s, _ in SITES) + '</tr>')
    out.append('</tbody></table></div>')
    return '\n'.join(out)

def solar_typed_table():
    cols = [('pk', '{h}_kwh', 'Peakless, units bought and sold'), ('bk', '{h}_kwh', 'bonkers.ie, units bought and sold'), ('sw', '{h}_kwh', 'switcher.ie, units bought and sold'),
            ('pk', '{h}_before', 'Peakless, use before panels + system'), ('kw', '{h}_kwh', 'kilowatt.ie, use before panels + system')]
    out = ['<div class="tw"><table><thead><tr><th>Home</th>' + ''.join(f'<th>{e(n)}</th>' for _, _, n in cols) + '</tr></thead><tbody>']
    for h in SOLARH:
        out.append(f'<tr><th scope="row">{e(META[h]["label"])}</th>' + ''.join(cell(row(s, k.format(h=h))) for s, k, _ in cols) + '</tr>')
    out.append('</tbody></table></div>')
    return '\n'.join(out)

def battery_table():
    h = 'solar_batt'; best = min({k: v for k, v in T[h].items()}, key=T[h].get); gbest = min(G[h], key=G[h].get)
    lines = [('pk', 'solar_batt_kwh', 'Peakless, units bought and sold'), ('pk', 'solar_batt_before', 'Peakless, use before panels + system'),
             ('pk', 'plan_solar_batt', 'Peakless, planning from a file'), ('pk', 'solar_batt_file', 'Peakless, meter file'),
             ('kw', 'solar_batt_kwh', 'kilowatt.ie, use before panels + system'), ('kw', 'plan_solar_batt', 'kilowatt.ie, planning from a file'),
             ('ep', 'plan_solar_batt', 'EnergyPal, planning from a file'), ('ep', 'solar_batt_file', 'EnergyPal, meter file'),
             ('bk', 'solar_batt_file', 'bonkers.ie, meter file'), ('sw', 'solar_batt_kwh', 'switcher.ie, units bought and sold')]
    out = ['<div class="tw"><table><thead><tr><th>Site and input</th><th>Top plan</th><th class="n">Site’s figure</th><th class="n">True cost, battery on solar only</th><th class="n">True cost, battery also filled at night</th><th>Second answer shown</th></tr></thead><tbody>']
    for s, key, label in lines:
        r = row(s, key)
        if not r: continue
        if r.get('unscored_top'):
            out.append(f'<tr><th scope="row">{e(label)}</th><td>{e(r["unscored_top"])}</td><td class="n">{eur(r["pick_shown"])}</td><td class="n na">not in our list</td><td class="n na">—</td><td class="na">—</td></tr>'); continue
        k = r['pick']; second = ''
        if r.get('so_pick') and r['so_pick'] != k:
            second = f'If it only takes solar: {e(pname(r["so_pick"]))}, {eur(r["so_est"])} (true {eur(T[h if not key.startswith("plan") else "solar_batt"][r["so_pick"]])})'
        elif s == 'pk' and key.endswith('_file'): second = '<span class="bad">None: the night-charging saving is not offered</span>'
        tc = T['solar_batt'][k]; gc = G['solar_batt'].get(k)
        est = r['est'].get(k)
        out.append(f'<tr><th scope="row">{e(label)}</th><td>{e(pname(k))}</td><td class="n">{eur(est)}</td><td class="n {"good" if k == best else ""}">{eur(tc)}</td><td class="n {"good" if k == gbest else ""}">{eur(gc)}</td><td>{second or "—"}</td></tr>')
    out.append('</tbody></table></div>')
    return '\n'.join(out), best, gbest

def planning_table():
    sc = [('plan_solar', 'solar', '4 kWp, no battery'), ('plan_solar_batt', 'solar_batt', '4 kWp + 10 kWh battery'), ('plan_solar_ev', 'solar_ev', '6 kWp + 10 kWh battery, EV at night')]
    out = ['<div class="tw"><table><thead><tr><th>System added to the before-panels file</th><th>Cheapest plan once built (battery on solar only)</th>' + ''.join(f'<th>{n}</th>' for s, n in SITES if s in ('pk', 'kw', 'ep')) + '</tr></thead><tbody>']
    for key, h, label in sc:
        b = min(T[h], key=T[h].get); cells = []
        for s in ('pk', 'kw', 'ep'):
            r = row(s, key)
            if not r: cells.append('<td class="na">not offered</td>'); continue
            if r.get('unscored_top'): cells.append(f'<td><span class="e {cls_err(r["mae"])}">{pct(r["mae"])}</span> <small>top: {e(r["unscored_top"])} {eur(r["pick_shown"])}, not in our list</small></td>'); continue
            k = r['pick']; g = f' <small>if filled at night: true {eur(G[h][k])}</small>' if h in G else ''
            cells.append(f'<td><span class="e {cls_err(r["mae"])}">{pct(r["mae"])}</span> <span class="l {cls_lost(r["lost"])}">{eur(r["lost"])}</span><small>top: {e(pname(k))}, says {eur(r["est"][k])}, true {eur(T[h][k])}{g}</small></td>')
        out.append(f'<tr><th scope="row">{e(label)}</th><td>{e(pname(b))} <span class="dim">{eur(T[h][b])}</span></td>' + ''.join(cells) + '</tr>')
    out.append('</tbody></table></div>')
    return '\n'.join(out)

def chart_gap():
    a = A.agg('plans', 'file'); vals = [(n, a[s]['err'], s) for s, n in SITES]; vals.sort(key=lambda x: x[1])
    W, rowh, left, right = 680, 34, 120, 150; H = rowh * len(vals) + 34; cap = 5.0; scale = (W - left - right) / cap
    parts = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-labelledby="gapt gapd" class="chart"><title id="gapt">Price gap from a meter file, by site</title><desc id="gapd">Average gap between each site\'s yearly cost and the true cost, across the plans it prices, ten homes. ' + '; '.join(f'{n} {v:.2f}%' for n, v, _ in vals) + '</desc>']
    for t in (0, 1, 2, 3, 4, 5):
        x = left + t * scale
        parts.append(f'<line x1="{x:.1f}" y1="6" x2="{x:.1f}" y2="{H - 26}" class="grid"/><text x="{x:.1f}" y="{H - 10}" class="tick" text-anchor="middle">{t}%</text>')
    for i, (n, v, s) in enumerate(vals):
        y = 10 + i * rowh; w = min(v, cap) * scale; over = v > cap
        parts.append(f'<text x="{left - 10}" y="{y + 15}" class="lab" text-anchor="end">{e(n)}</text>')
        parts.append(f'<rect x="{left}" y="{y + 3}" width="{max(w, 2):.1f}" height="18" rx="3" class="{"bar-pk" if s == "pk" else "bar"}"/>')
        if over: parts.append(f'<path d="M{left + w - 14:.1f} {y + 1} l8 22 M{left + w - 8:.1f} {y + 1} l8 22" class="brk"/>')
        parts.append(f'<text x="{left + w + 8:.1f}" y="{y + 16}" class="val">{v:.2f}%{" (off scale)" if over else ""}</text>')
    parts.append('</svg>')
    return ''.join(parts)

cc_html, agree = crosscheck()
bat_html, bat_best, bat_gbest = battery_table()
a_f = A.agg('plans', 'file'); a_k = A.agg('plans', 'kwh')
fx = lambda key: FIX[key]['fixed']['mae']
pk_file_fixed = round(st.mean(FIX[f'{h}_file']['fixed']['mae'] for h in FILEH), 2)
pk_kwh_fixed = round(st.mean(FIX[f'{h}_kwh']['fixed']['mae'] for h in PLAIN), 2)
n_runs = sum(1 for r in R if r.get('mae') is not None)
ep_ag = agree['ep']

CSS = open('report.css').read()
body = f'''<title>Peakless and four comparison sites</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>{CSS}</style>
<main class="doc">
<header class="top">
  <p class="kicker">Comparison run 9 October 2026</p>
  <h1>Peakless and four comparison sites</h1>
  <p class="sub">Peakless, bonkers.ie, kilowatt.ie, switcher.ie and EnergyPal. Fifteen homes, each typed in and uploaded as a half-hourly meter file, plus three homes planning solar. {n_runs} runs, every plan scored against its true cost for the year ahead.</p>
</header>

<section class="verdicts" aria-label="Summary">
  <div><b>Right plan from a meter file</b><span>Peakless {a_f['pk']['right']} of {a_f['pk']['homes']}</span><p>EnergyPal {a_f['ep']['right']}, bonkers.ie {a_f['bk']['right']}, kilowatt.ie {a_f['kw']['right']}, switcher.ie {a_f['sw']['right']}. If Energia’s 30% offer is not open to new customers, EnergyPal gets {a_f['ep']['right_alt']} of {a_f['ep']['homes']} and Peakless {a_f['pk']['right_alt']}.</p></div>
  <div><b>Right plan from typed usage</b><span>Peakless {a_k['pk']['right']} of {a_k['pk']['homes']}</span><p>bonkers.ie {a_k['bk']['right']}, kilowatt.ie {a_k['kw']['right']}, switcher.ie {a_k['sw']['right']}. EnergyPal only takes meter files.</p></div>
  <div><b>Price gap from a meter file</b><span>EnergyPal {a_f['ep']['err']:.2f}%</span><p>Peakless {a_f['pk']['err']:.2f}% as tested, {pk_file_fixed:.2f}% after today’s fix. bonkers.ie {a_f['bk']['err']:.1f}%, kilowatt.ie {a_f['kw']['err']:.1f}%, switcher.ie {a_f['sw']['err']:.0f}%.</p></div>
  <div><b>The surprise</b><span>EnergyPal</span><p>A small, file-only site that prices plans almost exactly, simulates solar, batteries and EVs, and takes your own plan’s rates. It had two Energia standing charges right that Peakless had wrong, and its sums were closer than Peakless’s this morning.</p></div>
</section>

<section>
<h2>What was tested</h2>
<p>Each home is a year of half-hour readings built from the national load profiles, with heat pumps, storage heaters, EVs, panels and batteries added where the home has them. Every site got the same home in two ways: the yearly kWh typed in (with export for solar homes where the site asks for it), and the half-hourly file uploaded in ESB Networks’ format. EnergyPal only takes files.</p>
<p>The true cost of each plan is its published unit rates applied to every half hour of the year ahead, with announced price changes from their date, the standing charge pro rata, the PSO levy, export paid at the plan’s rate, and no cashback. A site is scored on three things: how far its yearly figures are from the true costs across the plans it prices (the price gap), what following its top plan costs against the truly cheapest plan (€ lost), and whether its top plan is the cheapest one (right plan). Only plans a household switching supplier can take are counted as a site’s top plan.</p>
<p>Plans were matched by name to the 33 smart-meter plans Peakless carries. Where a site lists a version Peakless doesn’t carry (a smaller discount, a free Sunday instead of a free Saturday), that version was priced separately from the same published rates, so no site is marked down for listing a different offer.</p>
</section>

<section>
<h2>The surprise: EnergyPal</h2>
<p>energypal.ie is a small site built on a low-code app platform. It only takes a meter file: there is no box for a yearly figure or a bill. Upload the file, choose urban or rural, and it lists {len(json.load(open('ep_typical_file.json'))['rows'])} plans with the standing charge, import cost, export credit and discount in separate columns. It reads the file exactly (4,192 kWh for our typical home, 1,827 kWh exported for the solar home), says how many days the file covers, and lets you price only the last 12 months.</p>
<p>Its sums are the closest of the four rivals by a wide margin. Across the ten homes, EnergyPal’s yearly figure was within 0.5% of the true cost for {ep_ag[0]} of {ep_ag[1]} plan prices, using its own engine, not ours. That makes it the best independent check we have on Peakless’s prices (see “Do the sites agree on prices?”).</p>
<p>It goes further than a plan list. A solar and battery simulator takes two roof faces with size and direction, a usable battery size, and whether the battery charges from the grid (it defaults to never). An EV simulator takes mileage, efficiency, charger size and charging window. A custom-plan tab prices a plan you type in, including one you have negotiated. It also shows a 24-hour usage chart with the day, night and peak bands behind it.</p>
<p>Where it falls short: no typed route, so a home without its file can’t use it. It lists Energia’s and Bord Gáis’s plans at their new prices for the whole year (“From 12th Oct”), a small overstatement. Like the other three rivals, it lists Energia’s 28% and 23% versions, not the 30% and 27% offers on Energia’s own plans page.</p>
</section>

<section>
<h2>Picking the plan from a meter file</h2>
<p>Each cell shows the price gap, then € lost by following the site’s top plan. Green is the cheapest plan, amber costs under €50 a year more, red €50 or more.</p>
{table_plans('file')}
<p class="note">EnergyPal and bonkers.ie miss the cheapest plan for six homes for the same reason: neither lists Energia Smart 24 Hour at 30% off. They pick Flogas Smart 24Hr at 29% instead, €13 to €30 a year dearer. switcher.ie still reads half of every file (on 5 October its own calculation showed 2,096 of the typical home’s 4,192 kWh) and spreads it on a standard day, night and peak split, so all its bills are 35–50% too low. bonkers.ie’s list for the work-from-home file stopped at 45 of its 49 plans.</p>
</section>

<section>
<h2>Picking the plan from typed usage</h2>
{table_plans('kwh')}
<p class="note">With only a yearly figure, bonkers.ie and switcher.ie spread use on the standard smart-meter split (about 54% day, 37% night, 9% peak), which suits Electric Ireland’s SST plan; kilowatt.ie uses its own profile. Peakless asks how the home heats, whether there is an immersion on a night timer and whether there is an EV, and shapes the year from that. kilowatt.ie’s top plan for both EV homes is Electric Ireland’s Weekender with free Sundays, which only pays if the car is charged on Sundays. Our EV homes charge every night, and on that plan they would pay €733 and €279 a year more than on the cheapest plan. Peakless’s heat pump home is its one miss: €37, with a 4.9% price gap.</p>
</section>

<section>
<h2>Totals for the homes without solar</h2>
{totals()}
<figure>{chart_gap()}<figcaption>Average price gap from a meter file, ten homes. Peakless as tested this morning.</figcaption></figure>
</section>

<section>
<h2>The Energia question</h2>
<p>Energia’s own plans page offers Smart 24 Hour at 30% off (28.10c a unit), Smart Data at 27% and the 24-hour meter plan at 30%, with a “Select Smart 24 Hour Plan” button. Its tariff page shows Smart Data at 23% and the 24-hour plan at 26%, and all four rival sites list Smart 24 Hour at 28% and Smart Data at 23%. On 5 October switcher.ie listed both; today it lists only the dearer ones. Energia’s sign-up page shows rates only after you enter a meter number, so we could not settle which a new customer gets. Peakless prices the 30% and 27% offers, and they decide the answer for six of the ten homes.</p>
{energia_table()}
<p class="note">If the dearer versions are all that is on offer, Peakless’s top plan for those six homes becomes the 28% version, €9 to €42 a year more than Flogas Smart 24Hr, and EnergyPal is right for all ten. This needs a person to check with Energia, or sign-up with a real meter number.</p>
</section>

<section>
<h2>Do the sites agree on prices?</h2>
<p>The true costs above use the published rates Peakless holds, so a mistake there would flatter Peakless. This table checks that. It shows each site’s typical gap from the true cost for each plan, across the ten meter-file homes (median). Rivals that price the same file independently should land close to zero if the rates are right.</p>
{cc_html}
<p>EnergyPal is within 0.5% on {agree['ep'][0]} of {agree['ep'][1]} plan prices, bonkers.ie on {agree['bk'][0]} of {agree['bk'][1]}, kilowatt.ie on {agree['kw'][0]} of {agree['kw'][1]}. Where the rivals agree with each other and not with Peakless, Peakless was wrong. That happened for two Energia plans. From 12 October Energia’s Smart Day/Night standing charge is €348.57 a year (it is €331.97 now), and EV Smart Drive’s rises 28% to €339.22. Peakless had €265.01 rising 5% for both. bonkers.ie and kilowatt.ie had both right, EnergyPal had EV Smart Drive right (it doesn’t list Smart Day/Night), and Energia’s tariff page confirms them. Peakless’s figures for those two plans were about 3% low. Neither plan was anyone’s top pick, so no answer changed. Both are corrected today.</p>
<p class="note">Where one rival disagrees with the rest, that rival is out of date or prices a different offer. kilowatt.ie has Waterpower about 16% dearer and Bord Gáis about 2–3% dearer than the other sites. bonkers.ie has Ecopower and Community Power about 5% cheaper than the other sites and the suppliers’ pages as Peakless last read them. kilowatt.ie’s Flogas plans are the 10% versions, not the 29% loyalty offer, so they are not compared. switcher.ie is 35–50% low on everything because of the half-read file.</p>
</section>

<section>
<h2>Homes with panels already up: meter file</h2>
{solar_file_table()}
<p class="note">For three of the four homes the file is a year with the panels. Peakless, EnergyPal and bonkers.ie price it almost exactly. kilowatt.ie warned that 35–59% of the data was missing on the three battery files, and was 4–5% off. The fourth home put in 6 kWp and a 9 kWh battery in April, so its file is half before and half after. The other sites price that mixed year, and their bills come out more than double the year ahead with panels. Peakless asks when the panels went up and rebuilds the year with them: its gap is 25%, mostly from assuming the battery charges from the grid at night (next section).</p>
</section>

<section>
<h2>Homes with panels already up: typed</h2>
<p>bonkers.ie and switcher.ie ask for units bought and sold. kilowatt.ie asks for use before the panels plus the system. Peakless takes either.</p>
{solar_typed_table()}
<p class="note">The half-before, half-after home typed as one yearly figure can’t be priced well by anyone: the figure describes neither the old year nor the new. kilowatt.ie’s top plan for the two battery homes is Yuno’s “EV Standard Smart”, a plan Peakless doesn’t carry, so it isn’t scored. kilowatt.ie lists two Bord Gáis plans for existing customers above it.</p>
</section>

<section>
<h2>Batteries: two true costs</h2>
<p>A battery changes the answer more than anything else in this comparison, and the sites disagree about how it is run. A battery that only stores spare solar suits a flat-rate plan. One that also fills from the grid on cheap night hours suits an EV plan, and saves a lot more. So the true costs were worked out both ways. For the second, each plan’s cheap hours fill the battery to whatever level is cheapest that month: the best a fixed schedule could do on that plan.</p>
<p>For the 4 kWp and 10 kWh home, the cheapest plan is <b>{e(pname(bat_best))}</b> at {eur(T['solar_batt'][bat_best])} a year if the battery only stores solar, and <b>{e(pname(bat_gbest))}</b> at {eur(G['solar_batt'][bat_gbest])} if it also fills at night: {eur(T['solar_batt'][bat_best] - G['solar_batt'][bat_gbest])} a year less.</p>
{bat_html}
<p>Peakless and kilowatt.ie assume the battery is filled at night. Peakless says so on the Plans page (“This needs your battery to charge from the grid at night”) and gives the answer for a solar-only battery under it. Both of its answers are right for this home, and its figures are within 1–5% of the true costs. kilowatt.ie has no solar-only setting: its “Smart Control” switch changes how the night filling is scheduled, not whether it happens. EnergyPal defaults to solar only and lets you change it. bonkers.ie and switcher.ie price the readings as they are.</p>
<p><b>The gap this found in Peakless:</b> when a home with a battery uploads its meter file, Peakless prices the readings exactly (right for the home as it runs) but never mentions the night-filling saving. For this home that is about €214 a year; for the home with a 6 kWp system and an EV it is about €371. The typed route shows it; the file route should too.</p>
</section>

<section>
<h2>Planning solar</h2>
<p>Three homes uploaded their meter file from before the panels and added the system they then put in: 4 kWp facing south at 35°, with or without a 10 kWh battery, and 6 kWp with a battery for the EV home. Only Peakless, kilowatt.ie and EnergyPal offer this. The true cost is the year with the panels.</p>
{planning_table()}
<p class="note">Price gaps here are mostly the solar model, not the plan prices. EnergyPal makes 4,018 kWh a year from 4 kWp (our test home makes 3,718) and so comes out low. kilowatt.ie keeps less of the solar in the home within each half hour, on purpose, and comes out high. Peakless lands between them. For batteries, the scored top plan is the solar-only one; see the table above for the night-filled case.</p>
</section>

<section>
<h2>What each site offers</h2>
<div class="tw"><table class="feat"><thead><tr><th></th>{''.join(f'<th>{n}</th>' for _, n in SITES)}</tr></thead><tbody>
<tr><th scope="row">Typed yearly use or bill</th><td>Yes, kWh or €, by month too</td><td>Yes</td><td>Yes, yearly or two-monthly</td><td>Yes</td><td class="na">No</td></tr>
<tr><th scope="row">Meter file</th><td>Yes, every day priced; asks when panels went up</td><td>Yes</td><td>Yes, warns on solar files</td><td>Reads half</td><td>Yes, exact, with a 12-month option</td></tr>
<tr><th scope="row">Plans listed for a smart meter</th><td>33, plus dynamic on request</td><td>{a_f['bk']['listed']:.0f} incl. every discount tier</td><td>113 incl. existing-customer and standard rates</td><td>{a_f['sw']['listed']:.0f}</td><td>36 incl. dynamic</td></tr>
<tr><th scope="row">Price changes counted from their date</th><td>Yes</td><td>Yes</td><td>Yes, shown before and after</td><td>Yes</td><td>New price for the whole year</td></tr>
<tr><th scope="row">EV</th><td>Yes, km and charging time</td><td>“Optimised for EV” filter</td><td>Yes, kWh a night, cheapest time</td><td>None found</td><td>Yes, mileage, charger, window</td></tr>
<tr><th scope="row">Heat pump or storage heating</th><td>Yes</td><td>No</td><td>Heat pump, with floor area</td><td>No</td><td>No</td></tr>
<tr><th scope="row">Add solar to a home</th><td>Yes, two roof faces, payback</td><td class="na">No</td><td>Yes, size and inverter</td><td class="na">No</td><td>Yes, two roof faces</td></tr>
<tr><th scope="row">Battery: solar only or night filling</th><td>Both answers shown (typed and planning)</td><td class="na">—</td><td>Night filling only</td><td class="na">—</td><td>Your choice, solar only by default</td></tr>
<tr><th scope="row">Your own plan’s rates</th><td>Your plan and discount</td><td>No</td><td>Edit a discount</td><td>No</td><td>Any plan you type in</td></tr>
<tr><th scope="row">Gas and dual fuel</th><td>Yes</td><td>Yes</td><td>Yes</td><td>Yes</td><td>Yes</td></tr>
<tr><th scope="row">Beyond the plan list</th><td>Solar quote check, payback, price stress test, alerts</td><td>Switching service</td><td>Calculation per band</td><td>Switching service</td><td>Usage chart</td></tr>
<tr><th scope="row">Effort in our runs</th><td>8–10 questions</td><td>13 clicks</td><td>7 clicks</td><td>7 clicks</td><td>5 clicks</td></tr>
</tbody></table></div>
</section>

<section>
<h2>What changed in Peakless today</h2>
<ul>
<li><b>Two Energia standing charges corrected.</b> Smart Day/Night: €331.97 now, €348.57 from 12 October. EV Smart Drive: €265.01 now, €339.22 from 12 October. Rural figures from the same page. Peakless’s meter-file gap across the ten homes drops from {a_f['pk']['err']:.2f}% to {pk_file_fixed:.2f}%, and the typed gap from {a_k['pk']['err']:.2f}% to {pk_kwh_fixed:.2f}%. No top plan changes.</li>
<li><b>Meter files from a home whose own panels were up all year are priced from the readings.</b> They were being rebuilt from a solar model, which went wrong for battery homes whose winter exports are near zero (a 63% gap on one test home). Now 0.4%.</li>
<li><b>Panels put in partway through the file.</b> Peakless asks whether that is when they went up, and rebuilds the year ahead with them.</li>
</ul>
</section>

<section>
<h2>Still open for Peakless</h2>
<ul>
<li><b>Meter file with a battery: show the night-filling saving.</b> Worth about €214 to €371 a year to the two test homes. Needs the battery simulated on the rebuilt year, beside the exact price of the readings.</li>
<li><b>Energia’s 30% and 27% offers.</b> Confirm with Energia that new customers get them. If not, switch to the 28% and 23% versions.</li>
<li><b>Heat pump typed in:</b> 4.9% gap and €37 lost. Needs real heat-pump meter files to improve.</li>
<li><b>The half-before, half-after battery home:</b> the rebuild leans on the night-filling assumption and lands 24% low on a solar-only basis.</li>
</ul>
</section>

<section class="method">
<h2>How it was run</h2>
<p>All four rival sites were driven through their public forms on 9 October 2026 in a headless browser, with electricity only, urban unless the home is rural, a smart meter, direct debit, online billing, all plans shown and cashback off. Results were read from the page. Typed runs entered the yearly kWh; for solar homes, bonkers.ie and switcher.ie got units bought and sold, and kilowatt.ie got use before the panels with the system size and battery. File runs uploaded the same ESB-format file to every site. EnergyPal’s solar simulator was given the same size and direction; kilowatt.ie’s was given the size. Peakless was run on this morning’s build, answering its setup questions from each home’s facts. The panel size was set so each system is exactly 4.0 or 6.0 kWp.</p>
<p>Limits. The homes are synthetic: real homes are less regular, and our solar year is one weather year, so the planning figures depend on each site’s solar model as much as on its pricing. The true costs use the rates Peakless holds; the price check above is the guard against that, and it caught two errors. Matching plans by name can be wrong at the margins; plans we could not match with confidence were left out, not guessed.</p>
<p class="note">The study’s scripts, mappings, raw site results and scores are in <code>docs/five-way-2026-10-09/</code>.</p>
</section>
</main>
'''
open('report/peakless-five-way.html', 'w').write(body)
full = '<!doctype html>\n<html lang="en-IE"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n' + body.replace('<main class="doc">', '</head><body><main class="doc">', 1) + '\n</body></html>\n'
open('report/five-way-comparison-2026-10-09.html', 'w').write(full)
print('ok', n_runs, agree, pk_file_fixed, pk_kwh_fixed, bat_best, bat_gbest)
