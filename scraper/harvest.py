#!/usr/bin/env python3
"""
Harvest the FULL public catalogue from each supplier, not a curated list.

The daily scraper re-verifies a fixed set of plan ids. This is the other half:
enumerate every residential electricity plan a supplier actually lists today,
with its real current rates, so the app can rank the whole market instead of a
hand-picked subset. It prints a catalogue and writes catalogue.json; it does not
touch tariffs.json.

Runs from a CI runner (supplier sites are unreachable from the dev container).
Flogas is absent on purpose: it publishes no rates anywhere machine-readable.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import requests
from bs4 import BeautifulSoup

from sources import fetch, embedded_json, pdf_text

S = requests.Session()
RULE = "=" * 72


def _eur(cent: float) -> float:
    return round(cent / 100.0, 4)


def _type_of(rates: dict) -> str:
    vals = {rates.get(b) for b in ("day", "night", "peak") if rates.get(b) is not None}
    if rates.get("ev") and rates["ev"] < min(v for v in vals if v) * 0.7:
        return "ev"
    return "flat" if len(vals) <= 1 else "tou"


# ---------------------------------------------------------------------------
# Bord Gáis — the full Salesforce catalogue, deduped to public plans
# ---------------------------------------------------------------------------

#: name prefixes that mark an affinity, partner or staff variant, not a plan a
#: member of the public can walk up and buy.
BG_PRIVATE = re.compile(r"\b(Fieldsales|Employee|Arcadian|EMC|Renewal|Winback|"
                        r"Retention|Partner|Affinity|Staff)\b", re.I)


def _bg_all_entries(html: str):
    out = []

    def rec(node, path=""):
        if isinstance(node, dict):
            if path.endswith(".entries"):
                for _, e in node.items():
                    if isinstance(e, dict):
                        out.append(e)
            for k, v in node.items():
                rec(v, f"{path}.{k}" if path else k)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                rec(v, f"{path}[{i}]")

    for b in embedded_json(html):
        rec(b)
    return out


def _bg_rates(entry: dict):
    est = ((entry.get("electricityDetail") or {}).get("estimated") or {})
    sr = est.get("smartRates") or {}
    if sr.get("day") and sr.get("night") and sr.get("peak"):
        return {"day": _eur(sr["day"]), "night": _eur(sr["night"]),
                "peak": _eur(sr["peak"]), "ev": _eur(sr.get("ev") or sr["night"])}
    flat = est.get("flatRate") or est.get("unitRate") or est.get("base")
    if flat:
        r = _eur(flat)
        return {"day": r, "night": r, "peak": r, "ev": r}
    return None


def harvest_bord_gais():
    plans = {}
    for url in ["https://www.bordgaisenergy.ie/home/our-plans?fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES",
                "https://www.bordgaisenergy.ie/home/our-plans?fuelType=ELECTRICITY&smartMeter=SMARTMETER_NO"]:
        got = fetch(url, session=S)
        if not got.ok:
            continue
        for e in _bg_all_entries(got.text):
            name = e.get("name")
            if not name or not str(e.get("fuelType", "")).lower().startswith("single"):
                continue
            if BG_PRIVATE.search(name):
                continue
            rates = _bg_rates(e)
            if not rates:
                continue
            # keep the newest New-customer offer per plan name
            key = name
            start = str(e.get("startDate", ""))
            is_new = "new" in str(e.get("offerCode", "")).lower()
            prev = plans.get(key)
            score = (1 if is_new else 0, start)
            if not prev or score > prev["_score"]:
                plans[key] = {"supplier": "Bord Gáis", "name": name,
                              "type": _type_of(rates), "rates": rates,
                              "_score": score}
    for p in plans.values():
        p.pop("_score", None)
    return list(plans.values())


# ---------------------------------------------------------------------------
# Energia — every row of the plans table
# ---------------------------------------------------------------------------

def harvest_energia():
    got = fetch("https://www.energia.ie/energy-plans/electricity", session=S)
    if not got.ok:
        return []
    text = BeautifulSoup(got.text, "lxml").get_text(" ", strip=True)
    out = []
    # time-of-use rows: "<name> ... Ac night, Bc day, Cc peak"
    for m in re.finditer(r"(\d{1,2}\.\d{1,2})\s*c\s*night,\s*(\d{1,2}\.\d{1,2})\s*c\s*day,\s*"
                         r"(\d{1,2}\.\d{1,2})\s*c\s*peak", text, re.I):
        night, day, peak = (float(m.group(i)) for i in (1, 2, 3))
        out.append({"supplier": "Energia", "name": _label_before(text, m.start()),
                    "type": "tou", "rates": {"day": _eur(day), "night": _eur(night),
                                             "peak": _eur(peak), "ev": _eur(night)}})
    # EV rows: "Ac EV rate, Bc all other"
    for m in re.finditer(r"(\d{1,2}\.\d{1,2})\s*c\s*EV rate,\s*(\d{1,2}\.\d{1,2})\s*c\s*all other",
                         text, re.I):
        ev, other = float(m.group(1)), float(m.group(2))
        o = _eur(other)
        out.append({"supplier": "Energia", "name": _label_before(text, m.start()),
                    "type": "ev", "rates": {"day": o, "night": o, "peak": o, "ev": _eur(ev)}})
    # flat rows: "<name> ... Xc/kWh ... 24hr" or "day, night and peak"
    for m in re.finditer(r"(\d{1,2}\.\d{1,2})\s*c/kWh\s*(?:24hr|day, night and peak)", text, re.I):
        r = _eur(float(m.group(1)))
        out.append({"supplier": "Energia", "name": _label_before(text, m.start()),
                    "type": "flat", "rates": {"day": r, "night": r, "peak": r, "ev": r}})
    return out


def _label_before(text: str, pos: int) -> str:
    """A short plan-name guess: the last two capitalised words before `pos`."""
    words = re.findall(r"[A-Z][A-Za-z/]+(?:\s+[A-Z][A-Za-z/]+){0,3}", text[max(0, pos-80):pos])
    return words[-1] if words else "?"


HARVESTERS = {"bord_gais": harvest_bord_gais, "energia": harvest_energia}


def main():
    which = sys.argv[1:] or list(HARVESTERS)
    catalogue = []
    for k in which:
        try:
            plans = HARVESTERS[k]()
        except Exception as e:
            print(f"{k} CRASHED: {type(e).__name__}: {e}")
            continue
        print(f"\n{RULE}\n{k}: {len(plans)} public plans\n{RULE}")
        for p in plans:
            print(f"  {p['supplier']:12} {p['type']:8} {p['name']!r:45} {p['rates']}")
        catalogue.extend(plans)
    Path("catalogue.json").write_text(json.dumps(catalogue, indent=2, ensure_ascii=False))
    print(f"\nwrote catalogue.json ({len(catalogue)} plans)")


if __name__ == "__main__":
    main()
