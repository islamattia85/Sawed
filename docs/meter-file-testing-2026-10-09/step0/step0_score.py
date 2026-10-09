"""Step 0: the five-way benchmark homes, run through Peakless as it was before the
tester fix (5179c9f), with it (3a8346b) and today (e22e94a). Same true costs, same
frozen prices and date for all three."""
import json, os, sys
FIVE = '/tmp/claude-0/-home-user-Sawed/74c17acb-5048-514f-a9cb-512d72f36e1c/scratchpad/five'
STEP = '/tmp/claude-0/-home-user-Sawed/74c17acb-5048-514f-a9cb-512d72f36e1c/scratchpad/step0'
sys.path.insert(0, FIVE); os.chdir(FIVE)
import score5 as S
C = ['ad1de59', '123f0ba', '5179c9f', '3a8346b', 'e22e94a']; rows = []
for h in S.meta:
    for m in ('kwh', 'file', 'before'):
        key = f'{h}_{m}'; r = {'home': h, 'mode': m, 'label': S.meta[h]['label']}
        for c in C:
            os.chdir(f'{STEP}/{c}')
            try: x = S.score('pk', key, h, 'file' if m == 'file' else 'kwh')
            except Exception as e: x = None
            os.chdir(FIVE)
            if x and x.get('mae') is not None:
                d = json.load(open(f'{STEP}/{c}/pk_{key}.json'))
                r[c] = dict(err=x['mae'], pick=x['pick'], lost=x['lost'], g_lost=x.get('g_lost'), kwh=d['info']['kwh'], basis=(d['info'].get('basis') or {}).get('mode'), rebuilt=(d['info'].get('basis') or {}).get('rebuilt'))
        if any(c in r for c in C): rows.append(r)
json.dump(rows, open(f'{STEP}/scores.json', 'w'), indent=1)
for r in rows:
    cells = '  '.join(f"{c}: {r[c]['err']:6}% {str(r[c]['pick'])[:14]:14} €{r[c]['lost']:<4}" if c in r else f'{c}: —' for c in C)
    print(f"{r['home']:11} {r['mode']:6} {cells}")
