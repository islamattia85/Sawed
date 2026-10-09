"""Energia's dearer versions of two plans, which the comparison sites list instead of
the offers on Energia's own plans page (Smart 24 Hour 30%, Smart Data 27%). Same
standard rates, smaller discount; standing and the 12 Oct rise as for the plan."""
import json, copy
import truth as tr
VAR = {'EN-SMART-24-HOUR@28': ('EN-SMART-24-HOUR', 0.72 / 0.70), 'EN-SMART@23': ('EN-SMART', 0.77 / 0.73), 'EN-24@26': ('EN-24', 0.74 / 0.70)}
for vid, (base, f) in VAR.items():
    p = copy.deepcopy(tr.P[base]); p['id'] = vid; p['rates'] = {k: v * f for k, v in p['rates'].items()}; tr.P[vid] = p
# Electric Ireland's Weekender with Sunday as the free day (the registry models Saturday).
p = copy.deepcopy(tr.P['EI-WKND']); p['id'] = 'EI-WKND@sun'; p['weekend'] = dict(p['weekend'], days=[6]); tr.P['EI-WKND@sun'] = p; VAR['EI-WKND@sun'] = ('EI-WKND', 1)
if __name__ == '__main__':
    meta = json.load(open('meta.json')); T = {}
    for k in meta:
        try: home = json.load(open(k + '_ahead.json'))
        except FileNotFoundError: home = json.load(open(k + '.json'))
        T[k] = {v: round(tr.cost(home, v, k == 'rural'), 2) for v in VAR if (v == 'EN-24@26') == (k == 'legacy24') and not (k == 'legacy24' and v == 'EI-WKND@sun')}
    json.dump(T, open('truth_var.json', 'w'))
    print(T['typical'], T['large'])
