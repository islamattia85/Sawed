import json, statistics as st, collections
rows = json.load(open('scores5.json'))
def agg(group, mode=None):
    out = collections.OrderedDict()
    for s in ('pk', 'bk', 'kw', 'sw', 'ep'):
        R = [r for r in rows if r['group'] == group and r['site'] == s and (mode is None or r['mode'] == mode) and r.get('mae') is not None]
        if not R: continue
        out[s] = dict(homes=len(R), err=round(st.mean(r['mae'] for r in R), 2), err_med=round(st.median(r['mae'] for r in R), 2),
            worst=max(R, key=lambda r: r['mae'])['home'] + f" {max(r['mae'] for r in R)}%",
            right=sum(r['lost'] == 0 for r in R), lost=sum(r['lost'] or 0 for r in R), lost_alt=sum(r['lost_alt'] or 0 for r in R),
            right_alt=sum((r['lost_alt'] or 0) <= 0 for r in R),
            plans=round(st.mean(r['n'] for r in R), 1), listed=round(st.mean(r['listed'] for r in R), 1),
            missing_best=sum(r['best_rank'] is None for r in R))
    return out
if __name__ == '__main__':
    for g, m in (('plans', 'kwh'), ('plans', 'file')):
        print('==', g, m)
        for s, a in agg(g, m).items(): print('  ', s, a)
