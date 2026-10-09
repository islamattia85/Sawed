#!/usr/bin/env python3
"""
Rebuild src/data/pvgis-ie.json: what 1 kWp of panels makes each month, from
PVGIS, for every region the app offers, eight roof directions and seven pitches.

    python3 scripts/pvgis.py

PVGIS (re.jrc.ec.europa.eu, the European Commission's solar tool) is the
reference installers and SEAI quote from. The app models panels hour by hour
from its own sky, and on its own came out 1.9% under PVGIS on a south roof
in Cork and 1.9% over on a south-west plus north-east pair. So each face's
output is anchored to these figures month by month (model.js: pvgisMonth), and
the app's own hours only decide when in the month it falls.

Settings: crystalline silicon, 14% system losses (as the app's 0.86), fixed
free-standing mount, PVGIS's own horizon, the SARAH2 sky (2005-2020).
"""
import json, os, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'src', 'data', 'pvgis-ie.json')
# The app's regions (model.js IRISH_REGIONS): their latitude, and a longitude in their counties.
REGIONS = {
    'northwest': (54.6, -7.9),
    'west': (53.2, -8.8),            # inland of Galway Bay: PVGIS has no sky over the sea
    'east': (53.35, -6.26),
    'midlands': (53.4, -7.6),
    'southeast': (52.6, -7.25),
    'south': (51.9, -8.47),
}
AZIMUTHS = [0, 45, 90, 135, 180, 225, 270, 315]   # the app's: degrees clockwise from north
TILTS = [0, 15, 25, 35, 45, 60, 90]

def fetch(lat, lon, tilt, az):
    aspect = ((az - 180 + 180) % 360) - 180           # PVGIS: 0 south, 90 west, -90 east
    url = (f'https://re.jrc.ec.europa.eu/api/v5_2/PVcalc?lat={lat}&lon={lon}&peakpower=1&loss=14'
           f'&angle={tilt}&aspect={aspect}&outputformat=json')
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                d = json.load(r)
            return [round(m['E_m'], 2) for m in d['outputs']['monthly']['fixed']]
        except Exception as e:  # noqa: BLE001 - retried, then reported
            if attempt == 4: raise
            time.sleep(2 ** attempt)

def main():
    out = {'source': 'PVGIS 5.2 PVcalc (re.jrc.ec.europa.eu/api/v5_2), 1 kWp, crystalline silicon, 14% system losses, '
                     'free-standing, PVGIS horizon, SARAH2 sky 2005-2020. kWh per kWp per month. Azimuth: degrees '
                     'clockwise from north, as the app keeps it.',
           'fetched': time.strftime('%Y-%m-%d'), 'azimuths': AZIMUTHS, 'tilts': TILTS, 'regions': {}}
    for key, (lat, lon) in REGIONS.items():
        months = {}
        flat = fetch(lat, lon, 0, 180)
        for tilt in TILTS:
            for az in AZIMUTHS:
                months[f'{tilt}|{az}'] = flat if tilt == 0 else fetch(lat, lon, tilt, az)
                time.sleep(0.15)
        out['regions'][key] = {'lat': lat, 'lon': lon, 'months': months}
        print(key, 'south 35:', round(sum(months['35|180'])), 'kWh/kWp', file=sys.stderr)
    json.dump(out, open(OUT, 'w'), separators=(',', ':'))
    print('written', OUT, os.path.getsize(OUT), 'bytes', file=sys.stderr)

if __name__ == '__main__':
    main()
