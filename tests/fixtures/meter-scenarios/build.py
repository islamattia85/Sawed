"""Build the meter-file scenarios: the homes, the truth for each, and the ESB file
each user would download, in ESB Networks' own format.

    python3 tests/fixtures/meter-scenarios/build.py

writes files/<scenario>.csv.gz, truth.json (per home) and scenarios.json (what
each user uploads and answers). Deterministic: the same files every time.
"""
import gzip, json, os, random, datetime as dt
import homes as H
import price as P

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'files'); os.makedirs(OUT, exist_ok=True)
D = dt.date
MPRN, SERIAL = '10000000001', '000000000099999999'      # made up: no real meter

# ------------------------------------------------------------------ the homes
def with_system(use, gen, cap=0, install=None, grid_months=(), export_from=None):
    """What the meter recorded: before `install` the home's own use; after it, bought and sold
    with the panels (and battery). export_from: the day ESB began recording exports (default: install)."""
    g = [v if (install is None or H.LOCAL[i].date() >= install) else 0.0 for i, v in enumerate(gen)]
    imp, exp = H.battery(use, g, cap, grid_fill_months=grid_months)
    if export_from:
        exp = [v if H.LOCAL[i].date() >= export_from else 0.0 for i, v in enumerate(exp)]
    return imp, exp, g

def add(*s): return [sum(v) for v in zip(*s)]

def build_homes():
    hs = {}
    a = H.scale_to(H.base_load(11), 4000)
    b = add(H.scale_to(H.base_load(12), 3600), H.scale_to(H.heat_pump(13), 3900))
    c = add(H.scale_to(H.base_load(14), 3600), H.scale_to(H.ev(15), 2400))
    d = add(H.scale_to(H.base_load(16, occupants=2), 3000), H.scale_to(H.heat_pump(17, kw_scale=0.9), 3500))
    zero = [0.0] * H.N
    pv_a = H.pv_cork([(4.0, 180, 35)], 21); pv_b = H.pv_cork([(6.0, 180, 35)], 22)
    pv_d = H.pv_cork([(12 * 0.44, 225, 35), (10 * 0.44, 45, 35)], 23)
    pv_plan = H.pv_cork([(4.0, 180, 35)], 24)
    ev_a = H.scale_to(H.ev(31), 2400); hp_a = H.scale_to(H.heat_pump(32), 3900)
    # Homes as they are now (the truth is priced on these).
    hs['gas'] = dict(label='Gas-heated home, 4,000 kWh', use=a, imp=a, exp=zero, gen=zero)
    hs['heatpump'] = dict(label='Heat pump home, 7,500 kWh, heavy winter', use=b, imp=b, exp=zero, gen=zero)
    hs['ev'] = dict(label='EV charged at night, 6,000 kWh', use=c, imp=c, exp=zero, gen=zero)
    i, e, g = with_system(a, pv_a, 0, D(2025, 5, 12))
    hs['gas_solar'] = dict(label='Gas home, 4 kWp south since 12 May 2025, no battery', use=a, imp=i, exp=e, gen=g, install='2025-05-12', system=dict(kwp=4.0, faces=[[9, 180, 35]], panel_w=4000 / 9, battery=0, cost=7800, grant=1800))
    i, e, g = with_system(b, pv_b, 10, D(2025, 3, 3))
    hs['hp_solar_batt'] = dict(label='Heat pump home, 6 kWp + 10 kWh battery since 3 Mar 2025, battery on solar only', use=b, imp=i, exp=e, gen=g, install='2025-03-03', system=dict(kwp=6.0, faces=[[13, 180, 35]], panel_w=6000 / 13, battery=10, cost=12500, grant=2400))
    i, e, g = with_system(b, pv_b, 10, D(2025, 3, 3), grid_months=(11, 12, 1, 2))
    hs['hp_solar_gridfill'] = dict(label='Heat pump home, 6 kWp + 10 kWh battery, filled from the grid at night Nov-Feb', use=b, imp=i, exp=e, gen=g, install='2025-03-03', system=dict(kwp=6.0, faces=[[13, 180, 35]], panel_w=6000 / 13, battery=10, cost=12500, grant=2400))
    i, e, g = with_system(d, pv_d, 9, D(2025, 10, 20), export_from=D(2025, 12, 1))
    hs['friend'] = dict(label="The tester's case, rebuilt: heat pump 6,500 kWh, 22 panels on two faces, 9 kWh battery, panels from 20 Oct 2025, exports recorded from 1 Dec 2025", use=d, imp=i, exp=e, gen=g, install='2025-10-20', system=dict(kwp=9.68, faces=[[12, 225, 35], [10, 45, 35]], panel_w=440, battery=9, cost=10600, grant=0))
    # Homes whose file is not the home as it is now.
    ev_from = [v if H.LOCAL[k].date() >= D(2026, 4, 1) else 0.0 for k, v in enumerate(ev_a)]
    hs['gas_ev_now'] = dict(label='Gas home that bought an EV on 1 Apr 2026', use=add(a, ev_a), imp=add(a, ev_a), exp=zero, gen=zero, file_imp=add(a, ev_from))
    hp_from = [v if H.LOCAL[k].date() >= D(2026, 1, 15) else 0.0 for k, v in enumerate(hp_a)]
    hs['gas_to_hp'] = dict(label='Gas home that put in a heat pump on 15 Jan 2026', use=add(a, hp_a), imp=add(a, hp_a), exp=zero, gen=zero, file_imp=add(a, hp_from))
    vac = [0.07 if D(2026, 8, 3) <= H.LOCAL[k].date() <= D(2026, 8, 30) else v for k, v in enumerate(a)]
    hs['gas_holiday'] = dict(label='Gas home, away 3-30 Aug 2026', use=a, imp=a, exp=zero, gen=zero, file_imp=vac)
    # The planning system every no-solar home is quoted: 4 kWp south, no battery, EUR 7,800 less EUR 1,800 grant.
    PLAN_SYS = dict(kwp=4.0, faces=[[9, 180, 35]], panel_w=4000 / 9, battery=0, cost=7800, grant=1800)
    return hs, pv_plan, PLAN_SYS

# ------------------------------------------------------------------ the truth
def in_year(i): return H.TRUTH_YEAR[0] <= H.LOCAL[i].date() <= H.TRUTH_YEAR[1]

def truth_for(h, pv_plan, plan_sys):
    idx = [i for i in range(H.N) if in_year(i)]
    loc = [H.LOCAL[i].replace(tzinfo=None) for i in idx]
    imp = [h['imp'][i] for i in idx]; exp = [h['exp'][i] for i in idx]; use = [h['use'][i] for i in idx]
    costs = P.all_costs(loc, imp, exp); best = min(costs, key=costs.get)
    t = dict(label=h['label'], year=[str(H.TRUTH_YEAR[0]), str(H.TRUTH_YEAR[1])], use_kwh=round(sum(use)), bought_kwh=round(sum(imp)),
             sold_kwh=round(sum(exp)), gen_kwh=round(sum(h['gen'][i] for i in idx)), costs=costs, best=best, best_cost=costs[best])
    # The solar saving and payback, counted as the app counts them: the cheapest plan without
    # the panels less the cheapest plan with them; the price after grant over that.
    sys = h.get('system')
    if sys:
        nos = P.all_costs(loc, use, [0.0] * len(use)); wi = costs
    else:
        sys = plan_sys
        si, se = H.battery(h['use'], pv_plan, 0)
        nos = costs; wi = P.all_costs(loc, [si[i] for i in idx], [se[i] for i in idx])
        t['plan_gen_kwh'] = round(sum(pv_plan[i] for i in idx))
    saving = min(nos.values()) - min(wi.values())
    t['system'] = sys; t['saving'] = round(saving, 2)
    t['payback'] = round((sys['cost'] - sys['grant']) / saving, 2) if saving > 0 else None
    t['best_without_solar'] = min(nos, key=nos.get); t['best_with_solar'] = min(wi, key=wi.get)
    return t

# ------------------------------------------------------------------ ESB files
def esb_text(imp, exp, d0, d1, export=True, unit='kW', serial_change=None, export_from=None):
    """ESB Networks HDF: half-hourly, end-of-interval local times, DD-MM-YYYY HH:MM, newest first."""
    rows = []
    for i in range(H.N - 1, -1, -1):
        day = H.LOCAL[i].date()
        if not (d0 <= day <= d1): continue
        end = (H.SLOTS[i] + dt.timedelta(minutes=30)).astimezone(H.TZ).strftime('%d-%m-%Y %H:%M')
        ser = SERIAL if not serial_change or day < serial_change else '000000000088888888'
        f = 2 if unit == 'kW' else 1
        rows.append(f'{MPRN},{ser},{imp[i] * f:.3f},Active Import Interval ({unit}),{end}')
        if export and (export_from is None or day >= export_from):
            rows.append(f'{MPRN},{ser},{exp[i] * f:.3f},Active Export Interval ({unit}),{end}')
    return 'MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time\n' + '\n'.join(rows) + '\n'

def daily_register(imp, d0, d1, two_rate=False):
    """ESB's daily snapshot file: one register reading a day (cumulative kWh), or day and night registers."""
    reg = {'Day': 21345.0, 'Night': 8765.0, '24h': 30110.0}; out = []; byday = {}
    for i in range(H.N):
        day = H.LOCAL[i].date()
        if not (d0 <= day <= d1): continue
        k = 'Night' if (H.LOCAL[i].hour >= 23 or H.LOCAL[i].hour < 8) else 'Day'
        byday.setdefault(day, {'Day': 0, 'Night': 0}); byday[day][k] += imp[i]
    acc = []
    for day in sorted(byday):
        if two_rate:
            reg['Day'] += byday[day]['Day']; reg['Night'] += byday[day]['Night']
            acc.append((day, [('Active Import Register Day (kWh)', reg['Day']), ('Active Import Register Night (kWh)', reg['Night'])]))
        else:
            reg['24h'] += byday[day]['Day'] + byday[day]['Night']
            acc.append((day, [('24 Hr Active Import Register (kWh)', reg['24h'])]))
    for day, regs in reversed(acc):
        stamp = (day + dt.timedelta(days=1)).strftime('%d-%m-%Y') + ' 00:00'
        for t, v in regs: out.append(f'{MPRN},{SERIAL},{v:.3f},{t},{stamp}')
    return 'MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time\n' + '\n'.join(out) + '\n'

def put(name, text):
    data = text.encode('utf-8') if isinstance(text, str) else text
    # mtime=0: no timestamp in the gzip header, so the same homes give the same bytes.
    with open(os.path.join(OUT, name + '.gz'), 'wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, compresslevel=9, mtime=0) as f: f.write(data)
    return name + '.gz'

# ------------------------------------------------------------------ scenarios
YEAR_NOW = (D(2025, 10, 9), D(2026, 10, 8))
def S(id, group, title, home, truth, file, answers, **kw):
    return dict(id=id, group=group, title=title, home=home, truth=truth, file=file, answers=answers, **kw)

NO_SOLAR = lambda heat, ev='no': dict(heat=heat, ev=ev, solar='thinking')
def HAVE(sys, battery=None, **kw):
    a = dict(solar='have', panels=sum(f[0] for f in sys['faces']), battery=sys['battery'] if battery is None else battery, gridnow='no')
    a.update(kw); return a

def scenarios(hs):
    out = []
    homes_a = [('gas', 'gas'), ('heatpump', 'heatpump'), ('ev', 'gas')]
    windows = [('A1', 'Calendar year 2025', D(2025, 1, 1), D(2025, 12, 31)),
               ('A2', 'Twelve months, March 2025 to February 2026', D(2025, 3, 1), D(2026, 2, 28)),
               ('A3a', 'Nine months, June 2025 to February 2026 (no spring)', D(2025, 6, 1), D(2026, 2, 28)),
               ('A3b', 'Nine months, September 2025 to May 2026 (no summer)', D(2025, 9, 1), D(2026, 5, 31)),
               ('A4', 'This year so far, 1 January to 8 October 2026', D(2026, 1, 1), D(2026, 10, 8)),
               ('A5a', 'Four summer weeks, July 2026', D(2026, 7, 1), D(2026, 7, 28)),
               ('A5b', 'Four winter weeks, January 2026', D(2026, 1, 5), D(2026, 2, 1)),
               ('A5c', 'Two summer weeks, August 2026', D(2026, 8, 10), D(2026, 8, 23)),
               ('A6', 'An old year, July 2024 to June 2025', D(2024, 7, 1), D(2025, 6, 30)),
               ('A7', 'Two years, October 2024 to October 2026', D(2024, 10, 9), D(2026, 10, 8))]
    for sid, title, d0, d1 in windows:
        for hk, heat in homes_a:
            h = hs[hk]; name = f'{sid}_{hk}.csv'
            put(name, esb_text(h['imp'], h['exp'], d0, d1, export=False))
            out.append(S(f'{sid}-{hk}', 'A', title, hk, hk, name, dict(NO_SOLAR('heatpump' if hk == 'heatpump' else 'gas', 'have' if hk == 'ev' else 'no'), evtime='night'), window=[str(d0), str(d1)]))
    # B: homes with panels.
    f = hs['friend']; fs = f['system']
    for sid, title, d0, d1 in [('B1a', 'Full year before the panels', D(2024, 10, 20), D(2025, 10, 19)),
                               ('B1b', 'Half year before the panels', D(2025, 4, 20), D(2025, 10, 19)),
                               ('B1c', 'Summer before the panels', D(2025, 6, 1), D(2025, 8, 31)),
                               ('B1d', 'Winter before the panels', D(2024, 12, 1), D(2025, 2, 28))]:
        name = f'{sid}_friend.csv'; put(name, esb_text(f['imp'], f['exp'], d0, d1, export=False))
        out.append(S(f'{sid}-friend', 'B', title, 'friend', 'friend', name, dict(HAVE(fs), heat='heatpump', filewhen='before'), window=[str(d0), str(d1)]))
    for hk in ('gas_solar', 'hp_solar_batt'):
        h = hs[hk]; sy = h['system']; heat = 'gas' if hk == 'gas_solar' else 'heatpump'
        name = f'B2_{hk}.csv'; put(name, esb_text(h['imp'], h['exp'], *YEAR_NOW))
        out.append(S(f'B2-{hk}', 'B', 'A year after the panels, exports recorded', hk, hk, name, dict(HAVE(sy), heat=heat, filewhen='allyear'), window=[str(x) for x in YEAR_NOW]))
        name = f'B3_{hk}.csv'; put(name, esb_text(h['imp'], h['exp'], *YEAR_NOW, export=False))
        out.append(S(f'B3-{hk}', 'B', 'A year after the panels, no export rows', hk, hk, name, dict(HAVE(sy), heat=heat, filewhen=['noexport', 'allyear', 'before']), window=[str(x) for x in YEAR_NOW]))
    name = 'B3_friend.csv'; put(name, esb_text(f['imp'], f['exp'], *YEAR_NOW, export_from=D(2025, 12, 1)))
    out.append(S('B3-friend', 'B', 'Panels from 20 Oct 2025, exports recorded only from 1 Dec 2025 (the tester\'s case)', 'friend', 'friend', name, dict(HAVE(fs), heat='heatpump', filewhen=['allyear', 'noexport', 'before']), window=[str(x) for x in YEAR_NOW]))
    h = hs['gas_solar']; sy = h['system']; span = (D(2024, 10, 9), D(2025, 10, 8))
    name = 'B4_gas_solar.csv'; put(name, esb_text(h['imp'], h['exp'], *span))
    out.append(S('B4a-gas_solar', 'B', 'Before and after the panels (12 May 2025), exports recorded; user confirms the date', 'gas_solar', 'gas_solar', name, dict(HAVE(sy), heat='gas', filewhen='sinceyes'), window=[str(x) for x in span]))
    out.append(S('B4b-gas_solar', 'B', 'Same file; user says the panels were up the whole time', 'gas_solar', 'gas_solar', name, dict(HAVE(sy), heat='gas', filewhen='allyear'), window=[str(x) for x in span]))
    name = 'B4c_gas_solar.csv'; put(name, esb_text(h['imp'], h['exp'], *span, export=False))
    out.append(S('B4c-gas_solar', 'B', 'Before and after the panels, no export rows; user confirms the date shown', 'gas_solar', 'gas_solar', name, dict(HAVE(sy), heat='gas', filewhen='dropyes'), window=[str(x) for x in span]))
    hb = hs['hp_solar_batt']; span = (D(2024, 9, 1), D(2025, 8, 31))
    name = 'B4d_hp_solar_batt.csv'; put(name, esb_text(hb['imp'], hb['exp'], *span))
    out.append(S('B4d-hp_solar_batt', 'B', 'Before and after a battery system (3 Mar 2025), exports recorded; user confirms the date shown', 'hp_solar_batt', 'hp_solar_batt', name, dict(HAVE(hb['system']), heat='heatpump', filewhen='sinceyes'), window=[str(x) for x in span]))
    g = hs['hp_solar_gridfill']
    name = 'B5_hp_solar_gridfill.csv'; put(name, esb_text(g['imp'], g['exp'], *YEAR_NOW))
    out.append(S('B5-hp_solar_gridfill', 'B', 'Battery filled from the grid at night in winter', 'hp_solar_gridfill', 'hp_solar_gridfill', name, dict(HAVE(g['system']), heat='heatpump', gridnow='yes', filewhen='allyear'), window=[str(x) for x in YEAR_NOW]))
    # Asked about the power sold (fileexp, from 9 Oct 2026), they say yes: the truth.
    out.append(S('B6-gas_solar', 'B', 'User says no solar; the file shows exports', 'gas_solar', 'gas_solar', 'B2_gas_solar.csv', dict(heat='gas', solar='no', fileexp='have'), window=[str(x) for x in YEAR_NOW]))
    name = 'B7_gas.csv'; put(name, esb_text(hs['gas']['imp'], hs['gas']['exp'], *YEAR_NOW, export=False))
    out.append(S('B7a-gas', 'B', 'User says they have 9 panels; the file shows a home without them (they have none)', 'gas', 'gas', name, dict(HAVE(hs['gas_solar']['system']), heat='gas', filewhen=['noexport', 'allyear']), window=[str(x) for x in YEAR_NOW]))
    out.append(S('B7b-gas', 'B', 'Same; user answers that the file is from before the panels', 'gas', 'gas', name, dict(HAVE(hs['gas_solar']['system']), heat='gas', filewhen='before'), window=[str(x) for x in YEAR_NOW]))
    out.append(S('B8-gas_solar', 'B', 'User says 14 panels; the home has 9', 'gas_solar', 'gas_solar', 'B2_gas_solar.csv', dict(HAVE(hs['gas_solar']['system']), panels=14, heat='gas', filewhen='allyear'), window=[str(x) for x in YEAR_NOW], override=dict(count_A=14)))
    # C: the home changed inside the file.
    for sid, hk, title, ans in [('C1', 'gas_ev_now', 'EV bought on 1 Apr 2026, halfway through the file', dict(NO_SOLAR('gas', 'have'), evtime='night')),
                                ('C2', 'gas_to_hp', 'Heat pump put in on 15 Jan 2026 (was gas)', NO_SOLAR('heatpump')),
                                ('C4', 'gas_holiday', 'Away for four weeks in August 2026', NO_SOLAR('gas'))]:
        h = hs[hk]; name = f'{sid}_{hk}.csv'; put(name, esb_text(h['file_imp'], h['exp'], *YEAR_NOW, export=False))
        out.append(S(f'{sid}-{hk}', 'C', title, hk, hk, name, ans, window=[str(x) for x in YEAR_NOW]))
    name = 'C3_previous_home.csv'; put(name, esb_text(hs['heatpump']['imp'], hs['heatpump']['exp'], *YEAR_NOW, export=False))
    # Asked whether the file is from the home they live in now (from 9 Oct 2026), they say no; with no
    # bill for the new home yet, they take the typical 4,200 kWh the app suggests.
    out.append(S('C3-moved', 'C', 'Moved house: the file is the old (heat pump) home; the new home is gas-heated', 'heatpump', 'gas', name, dict(NO_SOLAR('gas'), filehome='no', bill='kwh:4200'), window=[str(x) for x in YEAR_NOW]))
    # D: file and data problems, on the gas home.
    a = hs['gas']; base = esb_text(a['imp'], a['exp'], *YEAR_NOW, export=False)
    put('D1a_daily_register.csv', daily_register(a['imp'], *YEAR_NOW))
    put('D1b_calc_kwh.csv', esb_text(a['imp'], a['exp'], *YEAR_NOW, export=False, unit='kWh'))
    put('D1c_day_night_register.csv', daily_register(a['imp'], *YEAR_NOW, two_rate=True))
    lines = base.strip().split('\n')
    def recol(fn): return '\n'.join([lines[0]] + [fn(l) for l in lines[1:]]) + '\n'
    def mmdd(l):
        c = l.split(','); d_, t = c[4].split(' '); dd, mm, yy = d_.split('-'); c[4] = f'{mm}/{dd}/{yy} {t}'; return ','.join(c)
    def irish_excel(l):
        c = l.split(','); d_, t = c[4].split(' '); dd, mm, yy = d_.split('-'); hh, mi = t.split(':'); c[4] = f'{int(dd)}/{int(mm)}/{yy} {int(hh)}:{mi}'; return ','.join(c)
    put('D2a_us_dates.csv', recol(mmdd))
    put('D2b_semicolons.csv', '\n'.join(l.replace(',', ';').replace('.', ',') for l in lines) + '\n')
    put('D2c_renamed_header.csv', 'Meter,Serial,kW,Kind,When\n' + '\n'.join(lines[1:]) + '\n')
    put('D2d_excel_irish_dates.csv', recol(irish_excel))
    r = random.Random(5); drop = set(r.sample(range(1, 365), 10)) | set(range(150, 171))
    keep = [l for l in lines[1:] if (dt.datetime.strptime(l.split(',')[4][:10], '%d-%m-%Y').date() - YEAR_NOW[0]).days not in drop]
    put('D3a_gaps.csv', lines[0] + '\n' + '\n'.join(keep) + '\n')
    put('D3b_duplicated_rows.csv', lines[0] + '\n' + '\n'.join(l for l in lines[1:] for _ in (0, 1)) + '\n')
    put('D3c_first_part.csv', esb_text(a['imp'], a['exp'], D(2025, 10, 9), D(2026, 5, 31), export=False))
    put('D3c_second_part.csv', esb_text(a['imp'], a['exp'], D(2026, 3, 1), D(2026, 10, 8), export=False))
    put('D3d_meter_replaced.csv', esb_text(a['imp'], a['exp'], *YEAR_NOW, export=False, serial_change=D(2026, 3, 15)))
    put('D4_leap_and_clock_changes.csv', esb_text(a['imp'], a['exp'], D(2024, 1, 1), D(2024, 12, 31), export=False))
    put('D5a_empty.csv', '')
    put('D5b_header_only.csv', 'MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time\n')
    put('D5c_bank_statement.csv', 'Date,Description,Debit,Credit,Balance\n' + '\n'.join(f'{d:%d/%m/%Y},CARD PAYMENT {i},{r.uniform(3, 80):.2f},,{1000 - i:.2f}' for i, d in enumerate([D(2026, 1, 1) + dt.timedelta(days=k) for k in range(120)])) + '\n')
    put('D5d_gas_file.csv', 'GPRN,Read Date,Read Value,Read Type\n' + '\n'.join(f'1234567,{D(2025, 10, 9) + dt.timedelta(days=k):%d-%m-%Y},{3000 + k * 1.7:.1f},Actual' for k in range(365)) + '\n')
    put('D5e_pdf_renamed.csv', b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' + bytes(r.getrandbits(8) for _ in range(4000)) + b'\n%%EOF\n')
    big = [esb_text(a['imp'], a['exp'], D(2024, 1, 1), D(2026, 10, 8), export=True)]
    put('D5f_very_large.csv', big[0] + ''.join(big[0].split('\n', 1)[1] for _ in range(4)))   # the same rows five times: about 14 MB
    for sid, title, files, ans in [
        ('D1a', 'Daily register file instead of half-hourly', ['D1a_daily_register.csv'], NO_SOLAR('gas')),
        ('D1b', 'Half-hourly file in kWh, not kW', ['D1b_calc_kwh.csv'], NO_SOLAR('gas')),
        ('D1c', 'Day and night register file (24-hour or night-storage meter)', ['D1c_day_night_register.csv'], NO_SOLAR('gas')),
        ('D2a', 'Edited in Excel: US dates (MM/DD)', ['D2a_us_dates.csv'], NO_SOLAR('gas')),
        ('D2b', 'Edited in Excel: semicolons and comma decimals', ['D2b_semicolons.csv'], NO_SOLAR('gas')),
        ('D2c', 'Header row renamed', ['D2c_renamed_header.csv'], NO_SOLAR('gas')),
        ('D2d', 'Saved by Excel with Irish short dates (d/m/yyyy h:mm)', ['D2d_excel_irish_dates.csv'], NO_SOLAR('gas')),
        ('D3a', 'Missing days: ten single days and a three-week gap', ['D3a_gaps.csv'], NO_SOLAR('gas')),
        ('D3b', 'Every row twice', ['D3b_duplicated_rows.csv'], NO_SOLAR('gas')),
        ('D3c', 'Two overlapping files uploaded one after the other', ['D3c_first_part.csv', 'D3c_second_part.csv'], NO_SOLAR('gas')),
        ('D3d', 'Meter replaced in March: two serial numbers in one file', ['D3d_meter_replaced.csv'], NO_SOLAR('gas')),
        ('D4', 'Calendar 2024: 29 February and both clock changes', ['D4_leap_and_clock_changes.csv'], NO_SOLAR('gas')),
        ('D5a', 'Empty file', ['D5a_empty.csv'], NO_SOLAR('gas')),
        ('D5b', 'Header only', ['D5b_header_only.csv'], NO_SOLAR('gas')),
        ('D5c', 'A bank statement CSV', ['D5c_bank_statement.csv'], NO_SOLAR('gas')),
        ('D5d', 'A gas meter file', ['D5d_gas_file.csv'], NO_SOLAR('gas')),
        ('D5e', 'A PDF bill renamed .csv', ['D5e_pdf_renamed.csv'], NO_SOLAR('gas')),
        ('D5f', 'A very large file (the same 33 months five times, about 14 MB)', ['D5f_very_large.csv'], NO_SOLAR('gas')),
        ('D6', 'Typed 5,600 kWh in setup, then uploaded a file showing 4,000', ['D3d_meter_replaced.csv'], dict(NO_SOLAR('gas'), typed=5600))]:
        out.append(S(f'{sid}-gas', 'D', title, 'gas', 'gas', files[0], ans, files=files, window=[str(x) for x in YEAR_NOW]))
    return out

if __name__ == '__main__':
    hs, pv_plan, plan_sys = build_homes()
    truth = {k: truth_for(h, pv_plan, plan_sys) for k, h in hs.items()}
    json.dump(truth, open(os.path.join(HERE, 'truth.json'), 'w'), indent=1)
    sc = scenarios(hs)
    json.dump(sc, open(os.path.join(HERE, 'scenarios.json'), 'w'), indent=1)
    for k, t in truth.items():
        print(f"{k:18} use {t['use_kwh']:5} bought {t['bought_kwh']:5} sold {t['sold_kwh']:5} best {t['best']:18} EUR{t['best_cost']:7.0f}  saving {t['saving']:6.0f} payback {t['payback']}")
    print(len(sc), 'scenarios')
