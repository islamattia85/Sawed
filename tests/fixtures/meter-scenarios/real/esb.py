"""Read an ESB Networks meter file (30-minute readings), and anonymise one.

    read_esb(path)  -> [(utc_start, local_start, import_kwh, export_kwh)], oldest first
    anonymise(path_in, path_out)  -> writes a copy with the MPRN and meter serial replaced

ESB stamps the end of each half hour in Irish local time, newest first, kW or
kWh. The hour the clocks go back is listed twice: the first (in time order) is
summer time, the second winter time. A row repeated exactly is read once.
"""
import csv, datetime as dt, gzip, io, os
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Europe/Dublin')
FAKE_MPRN, FAKE_SERIAL = '10000000002', '000000000077777777'   # made up: no real meter


def _open(path):
    raw = open(path, 'rb').read()
    if raw[:2] == b'\x1f\x8b': raw = gzip.decompress(raw)
    return raw.decode('utf-8-sig', errors='replace')


def _cols(header):
    h = [c.strip().lower() for c in header]
    find = lambda *keys: next((i for i, c in enumerate(h) if any(k in c for k in keys)), None)
    return dict(mprn=find('mprn'), serial=find('serial'), value=find('value', 'kwh'), type=find('type'), date=find('date', 'time'))


def _stamp(s):
    s = s.strip()
    for f in ('%d-%m-%Y %H:%M', '%d/%m/%Y %H:%M', '%Y-%m-%d %H:%M', '%d-%m-%Y %H:%M:%S', '%Y-%m-%d %H:%M:%S', '%d/%m/%Y %H:%M:%S'):
        try: return dt.datetime.strptime(s, f)
        except ValueError: pass
    raise ValueError(f'cannot read the date "{s}" (expected day-month-year, as ESB writes it)')


def read_esb(path):
    rows = list(csv.reader(io.StringIO(_open(path))))
    c = _cols(rows[0])
    if c['value'] is None or c['type'] is None or c['date'] is None: raise ValueError('not an ESB 30-minute file: no value, type or date column')
    seen, kept = set(), []
    for r in rows[1:]:
        if len(r) <= max(c['value'], c['type'], c['date']): continue
        key = (r[c['type']].strip().lower(), r[c['date']].strip(), r[c['value']].strip())
        if key in seen: continue
        seen.add(key); kept.append(r)
    unit_kw = any('(kw)' in r[c['type']].lower() for r in kept[:200])
    f = 0.5 if unit_kw else 1.0
    # Time order: oldest first. ESB lists newest first; within the repeated October hour
    # that puts winter time before summer time, so a newest-first file is reversed.
    if kept and _stamp(kept[0][c['date']]) > _stamp(kept[-1][c['date']]): kept.reverse()
    slots, fold_seen = {}, {}
    for r in kept:
        t = r[c['type']].lower()
        if 'import' not in t and 'export' not in t: continue
        end = _stamp(r[c['date']])
        k = (t.split('(')[0].strip(), end)
        fold = fold_seen.get(k, 0); fold_seen[k] = fold + 1
        u_end = end.replace(tzinfo=TZ, fold=min(fold, 1)).astimezone(dt.timezone.utc)
        u0 = u_end - dt.timedelta(minutes=30)
        s = slots.setdefault(u0, [0.0, 0.0])
        s[1 if 'export' in t else 0] += float(r[c['value']]) * f
    out = []
    for u0 in sorted(slots):
        out.append((u0, u0.astimezone(TZ).replace(tzinfo=None), round(slots[u0][0], 4), round(slots[u0][1], 4)))
    return out


def anonymise(path_in, path_out):
    """The same file with the MPRN and meter serial replaced by made-up ones. Nothing else changes."""
    text = _open(path_in)
    rows = list(csv.reader(io.StringIO(text)))
    c = _cols(rows[0])
    for r in rows[1:]:
        if c['mprn'] is not None and c['mprn'] < len(r): r[c['mprn']] = FAKE_MPRN
        if c['serial'] is not None and c['serial'] < len(r): r[c['serial']] = FAKE_SERIAL
    buf = io.StringIO(); csv.writer(buf, lineterminator='\n').writerows(rows)
    data = buf.getvalue().encode('utf-8')
    os.makedirs(os.path.dirname(path_out), exist_ok=True)
    with open(path_out, 'wb') as fh:
        fh.write(gzip.compress(data, mtime=0) if path_out.endswith('.gz') else data)
    left = [v for v in (rows[1][c['mprn']] if c['mprn'] is not None and len(rows) > 1 else None,) if v and v != FAKE_MPRN]
    if left: raise RuntimeError('MPRN still present after anonymising')
    return len(rows) - 1
