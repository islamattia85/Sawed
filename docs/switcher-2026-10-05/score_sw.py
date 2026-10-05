import json, sys
sys.path.insert(0, '../deep')
from score_pk import score
D = '../deep/'
T = json.load(open(D + 'truth.json')); meta = json.load(open(D + 'meta.json'))
M = {
 'Home Electric+ 24 Hour Saver 16%': 'EI-24', 'Home Electric+ SST Saver 16%': 'EI-SST', 'Home Electric SST Saver 16%': 'EI-SST',
 'Home Electric+ Night Boost 5.5%': 'EI-NB',
 'Smart Data 27%': 'EN-SMART', 'Smart 24 Hour 30%': 'EN-SMART-24-HOUR', 'EV Smart Drive 10%': 'EN-EV',
 'Waterpower Smart Tariff (SST)': 'WP-SST',
 '1 Year Smart Day/Night/Peak 30% DD & eBill': 'SSE-DNP', '1 Year Smart Everyday 30% DD & eBill': 'SSE-EVDAY',
 'Smart Electricity 29% Loyalty Discount': 'FL-DNP', 'Smart 24Hr Electricity 29% Loyalty Discount': 'FL-24',
 'Smart EV Night Charge 29% Electricity Loyalty Discount': 'FL-EV',
 'Smart All Day Electricity 28% Discount': 'BG-24', 'Standard Smart New Elec Only 28% Discount': 'BG-TOU',
 'Smart Standard Plus Electricity 28% Discount (New Customers)': 'BG-TOU-PLUS', 'Smart EV Plus Electricity 15% Discount': 'BG-EV',
 'Smart Weekend New Elec Only 28% Discount': 'BG-WKND', 'Standard Variable Smart All Day Electricity 0% Discount': 'BG-STANDARD-VARIABLE-SMART-ALL-DAY-ELECTRICITY',
 '1 Year Smart Day/Night/Peak Electricity with Welcome Bonus': 'YN-DNP', '1 Year Electricity Variable Plan Smart with Welcome Bonus': 'YN-24',
 'EV Variable Discount Smart Electricity Plan Day/Night/Peak': 'YN-EV-DNP', 'EV Variable Discount Smart Electricity Plan 24hr': 'YN-EV',
 'Smart SST': 'CP-SST', 'Smart 10% Discount': 'EP-SST', 'Smart 24 Hour 10% Discount': 'EP-24',
}
PAY = ('Direct Debit', 'Pay on receipt of bill', 'Pay as you go', 'Credit/debit card')
def parse(f):
    L = [x.strip() for x in open(f).read().split('\n')]; out = []
    for i, l in enumerate(L):
        if l == 'Estimated annual bill':
            j = i
            while j > 0 and L[j] not in PAY: j -= 1
            out.append((L[j - 1], float(L[i - 1].replace('€', '').replace(',', ''))))
    return out
rows = []
for h in meta:
    Th = T[h]; best = min(Th, key=Th.get)
    for m in ('kwh', 'file'):
        try: cards = parse(f'sw_{h}_{m}.txt')
        except FileNotFoundError: continue
        if not cards: continue
        ranked = []
        for n, c in cards:
            k = M.get(n)
            if k and k in Th and all(x['id'] != k for x in ranked): ranked.append({'id': k, 'net': c})
        r = score(ranked, Th) or dict(n=0, mae=None, maxe=None)
        first = cards[0]; fk = M.get(first[0])
        r.update(home=h, mode=m, site='sw', best=best, pickname=first[0], firstpick=fk,
                 regret=round(Th[fk] - Th[best]) if fk in Th else None, n_listed=len(cards))
        rows.append(r)
json.dump(rows, open('sw_results.json', 'w'), indent=1)
for r in rows: print(f"{r['home']:11} {r['mode']:4} MAE {str(r['mae']):5}% n {r['n']:2}/{r['n_listed']:2} first {r['pickname'][:44]:44} regret {r['regret']}")
