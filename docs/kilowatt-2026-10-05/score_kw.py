import json, sys, statistics as s
sys.path.insert(0, '../deep')
from score_pk import score
DD = ' • Direct Debit & Online Billing'
M = {('Electric Ireland', 'Home Electric+ SST Discount'): 'EI-SST', ('Electric Ireland', 'Home Electric+ Saver Discount'): 'EI-24',
 ('Electric Ireland', 'Home Electric+ Night Boost Discount'): 'EI-NB', ('Electric Ireland', 'Home Electric+ Weekender Sunday Discount'): 'EI-WKND',
 ('WaterPower', 'Waterpower Smart Tariff (SST)'): 'WP-SST', ('Flogas', 'Smart 24Hr Electricity Loyalty Discount'): 'FL-24',
 ('Flogas', 'Smart EV Night Charge Electricity Loyalty Discount'): 'FL-EV', ('Flogas', 'Smart Electricity Discount'): 'FL-DNP',
 ('Energia', 'Smart 24 Hour Discount' + DD): 'EN-SMART-24-HOUR', ('Energia', 'Smart Data and Discount' + DD): 'EN-SMART',
 ('Energia', 'Smart Day Night Discount' + DD): 'EN-SMART-DAY-NIGHT', ('Energia', 'EV Smart Drive' + DD): 'EN-EV',
 ('SSE Airtricity', 'Smart Everyday Top Discount - Smart' + DD): 'SSE-EVDAY', ('SSE Airtricity', 'Smart Weekends - Smart' + DD): 'SSE-WKND',
 ('SSE Airtricity', 'Smart EV Max - Smart' + DD): 'SSE-EVMAX',
 ('Bord Gáis Energy', 'New Customer Smart All Day Electricity Discount'): 'BG-24', ('Bord Gáis Energy', 'New Customer Smart Standard Electricity Discount'): 'BG-TOU',
 ('Bord Gáis Energy', 'New Customer Smart Standard Plus Electricity Discount'): 'BG-TOU-PLUS', ('Bord Gáis Energy', 'New Customer Smart Weekend Electricity Discount'): 'BG-WKND',
 ('Bord Gáis Energy', 'New Customer Smart EV Plus Electricity Discount'): 'BG-EV', ('Bord Gáis Energy', 'Standard Variable Smart All Day Electricity'): 'BG-STANDARD-VARIABLE-SMART-ALL-DAY-ELECTRICITY',
 ('Yuno Energy', 'Variable Smart Discount'): 'YN-DNP', ('Yuno Energy', 'Variable Discount Plan 24h'): 'YN-24', ('Yuno Energy', 'EV Variable'): 'YN-EV', ('Yuno Energy', 'EV Variable Smart'): 'YN-EV-DNP',
 ('Ecopower Supply', 'Smart Meter - Domestic Discount'): 'EP-SST', ('Ecopower Supply', '24 Hour Smart Meter – Domestic'): 'EP-24', ('Community Power', 'Smart SST'): 'CP-SST',
 ('Pinergy', 'Pinergy Lifestyle Family Time'): 'PIN-FAM', ('Pinergy', 'Pinergy Lifestyle Standard Smart Tariff'): 'PIN-LF', ('Pinergy', 'Pinergy Lifestyle Working from Home Time'): 'PIN-WFH',
 ('PrepayPower', 'Smart Pay Day Night Peak Smart'): 'PPP-TOU',
 ('WaterPower', 'Domestic 24 Hour Online Billing'): 'WP-24', ('Electric Ireland', 'EnergySaver 24h Discount'): 'EI-ES', ('SSE Airtricity', 'Electricity Top Discount - 24h' + DD): 'SSE-24',
 ('Energia', 'Electricity 24 hour Discount' + DD): 'EN-24', ('Electric Ireland', 'Green Electricity 24h Discount'): 'EI-GREEN', ('Flogas', 'Electricity Discount 24h'): 'FL-STD-24', ('Community Power', 'Standard Variable Rate 24h'): 'CP-24'}
T = json.load(open('../deep/truth.json')); meta = json.load(open('../deep/meta.json'))
INELIGIBLE = ('Existing Customer', 'Smart-NHH', 'prepay', 'Pay As You Go', 'PAYG', 'Winter/Summer', 'Prepaid', 'Classic Pay', 'Smart Pay')
def kw_rows(h, m):
    d = json.load(open(f'kw_{h}_{m}.json')); Th = T[h]; ranked = []
    for c in d['cards']:
        k = M.get((c['s'], c['p']))
        if k and k in Th and all(x['id'] != k for x in ranked): ranked.append({'id': k, 'net': c['cost']})
    r = score(ranked, Th)
    top = d['cards'][0]; r['top'] = f"{top['s']} {top['p']}"; r['top_ineligible'] = any(x in top['p'] for x in INELIGIBLE)
    # The first plan a new customer on this meter can actually take.
    first = next((M.get((c['s'], c['p'])) for c in d['cards'] if not any(x in c['p'] for x in INELIGIBLE) and M.get((c['s'], c['p'])) in Th), None)
    r['pick'] = first; best = min(Th, key=Th.get); r['regret'] = round(Th[first] - Th[best]) if first else None
    r['n_listed'] = d['n']; r['clicks'] = d['clicks']; r['secs'] = d['secs']
    return r
if __name__ == '__main__':
    import os
    for h in meta:
        for m in ('kwh', 'file'):
            if not os.path.exists(f'kw_{h}_{m}.json'): continue
            r = kw_rows(h, m)
            print(f"{h:11} {m:4} MAE {r['mae']:5}% max {r['maxe']:5}% n {r['n']:2} pick {str(r['pick']):20} regret {r['regret']}  top: {r['top'][:50]}{' [not available to switchers]' if r['top_ineligible'] else ''}")
