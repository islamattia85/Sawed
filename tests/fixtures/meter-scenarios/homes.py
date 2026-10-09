"""Ground-truth homes for the meter-file scenarios.

Each home is a half-hour series of what it really used, from 1 January 2024 to the
end of 8 October 2026, built from its own activity and weather, not from the
load profiles Peakless uses (so the app is not marked against its own
assumptions). Solar homes add a Cork-like panel output and, where they have
one, a battery; what was bought and sold follows from those.

Everything is seeded: running this again gives the same homes.

Times are UTC half hours. The ESB files and the pricing both work in Irish
local time, converted per half hour (so the clock-change days come out as ESB
writes them: 46 half hours in March, 50 in October).
"""
import math, random, datetime as dt, json
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Europe/Dublin')
START = dt.datetime(2024, 1, 1, 0, 0, tzinfo=dt.timezone.utc)        # 1 Jan 2024 00:00 local (GMT)
END = dt.datetime(2026, 10, 8, 23, 0, tzinfo=dt.timezone.utc)        # 9 Oct 2026 00:00 local
N = int((END - START).total_seconds() // 1800)
SLOTS = [START + dt.timedelta(minutes=30 * i) for i in range(N)]
LOCAL = [t.astimezone(TZ) for t in SLOTS]
LAT, LON = 51.9, -8.47                                                # Cork
TRUTH_YEAR = (dt.date(2025, 10, 9), dt.date(2026, 10, 8))             # the last twelve months: the home as it is now

def local_dates():
    seen, out = set(), []
    for t in LOCAL:
        d = t.date()
        if d not in seen: seen.add(d); out.append(d)
    return out
DATES = local_dates()

# ---------------------------------------------------------------- weather
def weather(seed=7):
    """Daily mean temperature (C) and clearness (0-1) for each local date."""
    r = random.Random(seed); T, K = {}, {}; anom = 0.0
    for d in DATES:
        doy = d.timetuple().tm_yday
        anom = 0.78 * anom + r.gauss(0, 1.6)
        T[d] = 10.9 - 4.6 * math.cos(2 * math.pi * (doy - 22) / 365.25) + anom
        # Irish skies: more grey than clear, a little brighter in late spring.
        base = 0.36 + 0.08 * math.cos(2 * math.pi * (doy - 140) / 365.25)
        K[d] = min(0.78, max(0.06, base + r.gauss(0, 0.16)))
    return T, K
TEMP, CLEAR = weather()

def sun(t):
    """Solar elevation and azimuth (degrees) at a UTC time, Cork."""
    doy = t.timetuple().tm_yday; hr = t.hour + t.minute / 60
    g = 2 * math.pi / 365 * (doy - 1 + (hr - 12) / 24)
    decl = 0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g)
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g) - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    tst = hr * 60 + eqt + 4 * LON
    ha = math.radians(tst / 4 - 180); lat = math.radians(LAT)
    ce = math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(ha)
    el = math.asin(max(-1, min(1, ce)))
    az = math.atan2(math.sin(ha), math.cos(ha) * math.sin(lat) - math.tan(decl) * math.cos(lat))
    return math.degrees(el), (math.degrees(az) + 180) % 360

def pv(faces, seed):
    """kWh per half hour from panel faces [(kWp, azimuth, tilt)], inverter-limited."""
    r = random.Random(seed); out = [0.0] * N; kwp = sum(f[0] for f in faces)
    for i, t in enumerate(SLOTS):
        mid = t + dt.timedelta(minutes=15); el, az = sun(mid)
        if el <= 0.5: continue
        k = CLEAR[LOCAL[i].date()] * math.exp(r.gauss(0, 0.22))     # cloud passing within the day
        k = min(0.82, max(0.03, k))
        ghi = 1361 * math.sin(math.radians(el)) * k
        kd = 1.0 if k < 0.22 else (1.1 - 1.2 * k if k < 0.78 else 0.17)     # diffuse share
        dhi = ghi * min(1, max(0.12, kd)); dni = (ghi - dhi) / max(0.05, math.sin(math.radians(el)))
        p = 0.0
        for size, faz, tilt in faces:
            ti = math.radians(tilt)
            cosi = math.sin(math.radians(el)) * math.cos(ti) + math.cos(math.radians(el)) * math.sin(ti) * math.cos(math.radians(az - faz))
            poa = max(0, dni * cosi) + dhi * (1 + math.cos(ti)) / 2 + ghi * 0.2 * (1 - math.cos(ti)) / 2
            p += size * poa / 1000 * 0.84
        out[i] = min(p, 0.92 * kwp, 5.0 if kwp <= 6 else 8.0) * 0.5
    return out

# ---------------------------------------------------------------- households
PVGIS = json.load(open(__import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), 'pvgis-cork-35.json')))['faces']

def pv_cork(faces, seed):
    """Panel output anchored to PVGIS: each face's own weather-driven half hours, scaled month by
    month so its average month matches PVGIS for Cork at that direction. kWh per half hour."""
    total = [0.0] * N; kwp = sum(f[0] for f in faces)
    for k, (size, az, tilt) in enumerate(faces):
        raw = pv([(1.0, az, tilt)], seed + k)
        sums, counts = [0.0] * 12, [set() for _ in range(12)]
        for v, t in zip(raw, LOCAL): sums[t.month - 1] += v; counts[t.month - 1].add(t.year)
        target = PVGIS[str(az)]['months']
        f = [target[m] / (sums[m] / len(counts[m])) if sums[m] else 0 for m in range(12)]
        for i, (v, t) in enumerate(zip(raw, LOCAL)): total[i] += v * f[t.month - 1] * size
    cap = (5.0 if kwp <= 6 else 8.0) * 0.5          # the inverter, kWh per half hour
    return [min(v, cap) for v in total]

def base_load(seed, occupants=3, wfh=False):
    """An ordinary home's own electricity, kW per half hour: fridge, lights, cooking, washing, screens."""
    r = random.Random(seed); out = [0.0] * N
    events = {}
    for d in DATES:
        # Washing machine, dishwasher, tumble dryer: a few blocks a week, mostly daytime or evening.
        for _ in range(r.choice([0, 1, 1, 2, 2, 3])):
            start = r.choice([9, 10, 11, 13, 14, 18, 19, 20, 21]) * 2 + r.choice([0, 1])
            events.setdefault(d, []).append((start, r.choice([2, 3, 4]), r.uniform(0.8, 1.9)))
    for i, t in enumerate(LOCAL):
        d = t.date(); h = t.hour + t.minute / 60; wk = t.weekday() >= 5; doy = d.timetuple().tm_yday
        dark = 0.5 + 0.5 * math.cos(2 * math.pi * (doy - 355) / 365.25)          # 1 in midwinter, 0 midsummer
        kw = 0.13 + 0.03 * math.sin(i * 0.37) ** 2                                 # fridge, router, standby
        wake = 8.5 if wk else 7.0
        if wake <= h < wake + 1.5: kw += r.uniform(0.25, 0.9)                      # kettle, toaster, hair dryer
        if (wk or wfh) and 10 <= h < 17: kw += r.uniform(0.1, 0.45)
        if 17 <= h < 19.5: kw += r.uniform(0.5, 1.6) * (0.9 + 0.2 * wk)            # cooking
        if 19.5 <= h < 23: kw += r.uniform(0.2, 0.45)                              # screens
        if (16 <= h < 23.5) or (6.5 <= h < 8.5): kw += 0.25 * dark * (occupants / 3)  # lights
        if h >= 23.5 or h < 6.5: kw += 0.02
        for st, ln, p in events.get(d, []):
            s = t.hour * 2 + t.minute // 30
            if st <= s < st + ln: kw += p
        out[i] = kw * 0.5
    return out

def heat_pump(seed, kw_scale=1.0):
    """Air-to-water heat pump: space heating against Cork weather and hot water, kWh per half hour."""
    r = random.Random(seed); out = [0.0] * N
    w = [0.5] * 12 + [1.4] * 6 + [0.9] * 14 + [1.3] * 12 + [0.7] * 4     # night setback, morning and evening boosts
    for i, t in enumerate(LOCAL):
        d = t.date(); T = TEMP[d] + 3.5 * math.sin(2 * math.pi * (t.hour - 9) / 24)
        cop = max(2.0, min(4.6, 2.9 + 0.075 * (T - 7)))
        heat = max(0.0, 16.0 - T) * 0.21 * w[t.hour * 2 + t.minute // 30] * kw_scale   # kW of heat
        dhw = 2.4 if (t.hour == 13 and t.minute == 0) or (t.hour == 13 and t.minute == 30) else 0   # hot water cycle
        out[i] = (heat / cop + dhw / 2.4) * 0.5 * r.uniform(0.92, 1.08)
    return out

def ev(seed, from_date=None, kwh_year=2400):
    """A car charged from 02:00 at 7 kW on most nights, kWh per half hour."""
    r = random.Random(seed); out = [0.0] * N; need = {}
    for d in DATES:
        if from_date and d < from_date: continue
        if r.random() < 0.62: need[d] = r.uniform(5, 16) * kwh_year / 2400
    for i, t in enumerate(LOCAL):
        d = t.date()
        if d in need and need[d] > 0 and 2 <= t.hour < 6:
            take = min(3.5, need[d]); out[i] = take; need[d] -= take
    return out

def scale_to(series, target, window=TRUTH_YEAR):
    tot = sum(v for v, t in zip(series, LOCAL) if window[0] <= t.date() <= window[1])
    k = target / tot; return [v * k for v in series]

def battery(use, gen, cap, grid_fill_months=(), fill_to=1.0, eff=0.95, rate=1.5):
    """What was bought and sold with panels and a battery. The battery stores
    spare solar; in grid_fill_months it is also filled from the grid 02:00-05:00."""
    imp, exp = [0.0] * N, [0.0] * N; soc = 0.0
    for i in range(N):
        net = use[i] - gen[i]; t = LOCAL[i]
        night_fill = cap > 0 and t.month in grid_fill_months and 2 <= t.hour < 5
        if net < 0:
            c = min(-net, (cap - soc) / eff, rate); soc += c * eff; exp[i] = -net - c
        elif night_fill:
            imp[i] = net
        else:
            dch = min(net, soc, rate); soc -= dch; imp[i] = net - dch
        if night_fill and soc < fill_to * cap:
            c = min(rate, (fill_to * cap - soc) / eff); soc += c * eff; imp[i] += c
    return imp, exp
