import json, statistics as stx
from parse import parse
M={'Flogas|Smart 24Hr Electricity 29%':'FL-24','Flogas|Smart Electricity 29% Loyalty Discount':'FL-DNP','Flogas|Smart EV Night Charge 29%':'FL-EV',
'Waterpower|Standard Smart Electricity (SST)':'WP-SST','Energia|Smart Data':'EN-SMART','Energia|Smart 24 Hour':'EN-SMART-24-HOUR','Energia|Smart Day Night':'EN-SMART-DAY-NIGHT',
'Energia|Smart Drive 10%':'EN-EV','Energia|EV Smart Drive Plus':'EN-EV-PLUS','SSE Airtricity|30% Day/Night/Peak Electricity':'SSE-DNP','SSE Airtricity|Smart Everyday 30%':'SSE-EVDAY',
'SSE Airtricity|Smart EV Max 20%':'SSE-EVMAX','Electric Ireland|Home Electric SST 16%':'EI-SST','Electric Ireland|Home Electric+ Saver 16%':'EI-24','Electric Ireland|Home Electric+ Night Boost':'EI-NB',
'Electric Ireland|Home Electric+ Weekender':'EI-WKND','Bord Gáis Energy|Smart All Day Electricity 28%':'BG-24','Bord Gáis Energy|Standard Smart Electricity 28%':'BG-TOU',
'Bord Gáis Energy|Weekend Smart Electricity 28%':'BG-WKND','Bord Gáis Energy|Smart EV Plus Electricity':'BG-EV','Bord Gáis Energy|Standard Smart All Day Electricity':'BG-STANDARD-VARIABLE-SMART-ALL-DAY-ELECTRICITY',
'Yuno Energy|1 Year Smart Discount Electricity with Bonus':'YN-24','Yuno Energy|1 Year Smart Day/Night/Peak Electricity with Bonus':'YN-DNP','Yuno Energy|Smart EV Variable 24hr':'YN-EV',
'Yuno Energy|Smart EV Variable':'YN-EV-DNP','Community Power|Standard Smart Electricity (SST)':'CP-SST'}
def spearman(a,b):
    ra={k:i for i,k in enumerate(sorted(a,key=a.get))}; rb={k:i for i,k in enumerate(sorted(b,key=b.get))}
    n=len(a); d=sum((ra[k]-rb[k])**2 for k in a); return 1-6*d/(n*(n*n-1)) if n>2 else None
out={}
for h in ['h1','h2','h3']:
    T=json.load(open(f'{h}_truth.json')); tmin=min(T.values()); tbest=min(T,key=T.get)
    for site in ['bk','pk']:
        for mode in ['kwh','file']:
            if site=='bk':
                cards=parse(f'bk_{h}_{mode}.txt'); est={}; first=None
                for c in cards:
                    k=M.get(c['s']+'|'+c['p'])
                    if first is None: first=(k, c['s']+' '+c['p'])
                    if k and k in T and k not in est: est[k]=c['cost']
                pick=first[0]; pickname=first[1]
            else:
                d=json.load(open(f'pk_{h}_{mode}.json')); est={r['id']:r['net'] for r in d['ranked'] if r['id'] in T}
                pick=d['ranked'][0]['id']; pickname=pick
            errs=[abs(est[k]-T[k])/T[k]*100 for k in est]
            regret = (T[pick]-tmin) if pick in T else None
            # common set: plans both sites list (for fairness)
            out[(h,site,mode)]=dict(n=len(est), mae=round(stx.mean(errs),1), maxe=round(max(errs),1), within3=sum(e<=3 for e in errs), pick=pickname, regret=None if regret is None else round(regret), rho=round(spearman(est,{k:T[k] for k in est}),2), est=est)
    print(h,'true best',tbest,round(tmin))
    for site in ['bk','pk']:
        for mode in ['kwh','file']:
            o=out[(h,site,mode)]; print(f"  {site} {mode:4} n={o['n']:2} MAE={o['mae']:4}% max={o['maxe']:5}% within3%={o['within3']:2} rho={o['rho']} pick={o['pick'][:45]} regret=€{o['regret']}")
json.dump({'|'.join(k):{kk:vv for kk,vv in v.items()} for k,v in out.items()}, open('scores.json','w'))
