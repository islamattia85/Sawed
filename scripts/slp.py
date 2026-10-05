#!/usr/bin/env python3
"""
Rebuild src/slp-2026.js from ESB Networks' Standard Load Profiles (RMDS).

    pip install openpyxl
    python scripts/slp.py load-profile-indexes-2026.xlsx

The workbook is "Load Profile Indexes <year>" on
rmdservice.com/reference/standard-load-profiles. Sheet LP1 is the urban
domestic 24-hour home, LP3 the rural one. Each row is a day; columns C..CX are
the 96 quarter-hours, each the fraction of the year's use.
"""
import json, sys
import openpyxl

def profile(ws):
    hourly = [[0.0] * 24 for _ in range(12)]
    for r in ws.iter_rows(min_row=6, max_row=370, values_only=True):
        if not r[1]:
            continue
        for q, x in enumerate(r[2:98]):
            hourly[r[1].month - 1][q // 4] += x or 0
    shapes = [[round(x / (sum(h) / 24), 3) for x in h] for h in hourly]
    mon = [sum(h) for h in hourly]
    bi = [round((mon[2 * i] + mon[2 * i + 1]) / sum(mon) * 6, 3) for i in range(6)]
    return shapes, bi

wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
year = wb['LP1']['A3'].value
u, ub = profile(wb['LP1'])
r, rb = profile(wb['LP3'])
src = open('src/slp-2026.js').read().split('export const SLP_YEAR')[0]
out = src + f"""export const SLP_YEAR = {year};
export const SLP_URBAN_HOURLY = {json.dumps(u)};
export const SLP_RURAL_HOURLY = {json.dumps(r)};
export const SLP_URBAN_BIMONTHLY = {json.dumps(ub)};
export const SLP_RURAL_BIMONTHLY = {json.dumps(rb)};
"""
open('src/slp-2026.js', 'w').write(out)
print('written', year)
