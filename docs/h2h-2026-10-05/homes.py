import openpyxl, datetime as dt, json, random
wb=openpyxl.load_workbook('../slp/legacy.xlsx',read_only=True,data_only=True)
def qh(name):
    out={}
    for r in wb[name].iter_rows(min_row=6,max_row=370,values_only=True):
        if r[1]: out[r[1].date()]=[x or 0 for x in r[2:98]]
    return out
L1,L2=qh('LP1'),qh('LP2')
random.seed(7)
def home(prof,kwh,ev=0):
    tot=sum(sum(v) for v in prof.values()); hh=[]
    for d in sorted(prof, key=lambda d:(d.year-1 if d.month>=10 else d.year, d.month, d.day)):
        if d.month==2 and d.day==29: continue
        v=prof[d]
        for i in range(48):
            e=(v[2*i]+v[2*i+1])/tot*kwh*random.uniform(0.85,1.15)
            y=d.year-1 if d.month>=10 else d.year
            t=dt.datetime(y,d.month,d.day)+dt.timedelta(days=4, minutes=30*i)
            if ev and 2<=t.hour<5: e+=ev/365/6
            hh.append((t,e))
    s=sum(e for _,e in hh); target=kwh+ev
    return [(t,e*target/s) for t,e in hh]
H={'h1':home(L1,4200),'h2':home(L2,5000),'h3':home(L1,4200,2500)}
for k,v in H.items():
    rows=['MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time']
    for t,e in reversed(v):
        end=t+dt.timedelta(minutes=30)
        rows.append(f"10306268587,34201234,{e*2:.3f},Active Import Interval (kW),{end.strftime('%d-%m-%Y %H:%M')}")
    open(f'{k}.csv','w').write('\n'.join(rows)+'\n')
    json.dump([(t.isoformat(),e) for t,e in v],open(f'{k}.json','w'))
    print(k, round(sum(e for _,e in v)), len(v))
