import re, json
SUP = ['Bord Gáis Energy','Community Power','Ecopower','Electric Ireland','Energia','Flogas','Pinergy','PrepayPower','SSE Airtricity','Waterpower','Yuno Energy']
def parse(fn):
    L = [l.strip() for l in open(fn) if l.strip()]
    cards, cur = [], None
    for i,l in enumerate(L):
        m = re.match(r'^(%s) - (.+)$' % '|'.join(map(re.escape,SUP)), l)
        if m and (i+1 < len(L)) and not l.startswith('Save'):
            cur = {'s': m.group(1), 'p': m.group(2), 'rates': {}, 'note': ''}; cards.append(cur); continue
        if not cur: continue
        if re.match(r'^[\d.]+ cent$', l) and i+1 < len(L): cur['rates'][L[i+1]] = float(l.split()[0])
        if l == 'Annual standing charge': cur['standing'] = float(L[i-1].replace('€','').replace(',',''))
        if l == 'Estimated 1-year cost': cur['cost'] = float([x for x in L[i+1].replace(',','').split('€') if x.strip()][-1]); cur['cost_all'] = L[i+1]
        if 'price change effective' in l: cur['note'] = l
    return [c for c in cards if 'cost' in c]
if __name__=="__main__": out = {k: parse(f'b{k}.txt') for k in [2500,4200,6500,10000]}
if __name__=="__main__": json.dump(out, open('bk.json','w'), indent=1)
if __name__=="__main__":
 for c in out[4200]: print(c['s'],'|',c['p'],c['cost'],c.get('standing'),c['rates'], c['note'][:40])
