import json, statistics as s
T = json.load(open('truth.json')); meta = json.load(open('meta.json'))
def score(ranked, Th):
    e = {r['id']: r['net'] for r in ranked if r['id'] in Th}
    if not e: return None
    err = [abs(e[k] - Th[k]) / max(200, Th[k]) * 100 for k in e]
    pick = next((r['id'] for r in ranked if r['id'] in Th), None); best = min(Th, key=Th.get)
    return dict(n=len(e), mae=round(s.mean(err), 1), maxe=round(max(err), 1), pick=pick, best=best, regret=round(Th[pick] - Th[best]))
if __name__ == '__main__':
    for h in meta:
        for m in ('kwh', 'file'):
            try: d = json.load(open(f'pk_{h}_{m}.json'))
            except FileNotFoundError: continue
            r = score(d['ranked'], T[h]); print(f"{h:11} {m:4} MAE {r['mae']:5}% max {r['maxe']:5}% pick {r['pick']:20} best {r['best']:18} regret €{r['regret']}  {d.get('info')}")
