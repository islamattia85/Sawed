#!/usr/bin/env python3
"""
Harvest the FULL public catalogue from each supplier, not a curated list.

The daily scraper re-verifies a fixed set of plan ids. This is the other half:
enumerate every residential electricity plan a supplier actually lists today,
with its real current rates, so the app can rank the whole market instead of a
hand-picked subset. It prints a catalogue and writes catalogue.json; it does not
touch tariffs.json.

Runs from a CI runner (supplier sites are unreachable from the dev container).
Flogas is absent on purpose: it publishes no rates anywhere machine-readable
(not in HTML, JSON, PDF, or the rendered DOM — only behind a quote flow).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

from sources import fetch, embedded_json, pdf_text
from parsers import _sse_row, _sse_standing, SSE_OFFERS_URL, PINERGY_URL, YUNO_URL

S = requests.Session()
RULE = "=" * 72


def _eur(cent: float) -> float:
    return round(cent / 100.0, 4)


def _type_of(rates: dict) -> str:
    day, night, peak, ev = (rates.get(b) for b in ("day", "night", "peak", "ev"))
    if ev and day and ev < day * 0.7:
        return "ev"
    bands = {v for v in (day, night, peak) if v is not None}
    return "flat" if len(bands) <= 1 else "tou"


def _plan(supplier, name, rates, standing=None, source=""):
    return {"supplier": supplier, "name": name, "type": _type_of(rates),
            "rates": rates, "standing": standing, "source": source}


# ---------------------------------------------------------------------------
# Bord Gáis — the full Salesforce catalogue, deduped to public plans
# ---------------------------------------------------------------------------

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
            start = str(e.get("startDate", ""))
            is_new = "new" in str(e.get("offerCode", "")).lower()
            score = (1 if is_new else 0, start)
            prev = plans.get(name)
            if not prev or score > prev[0]:
                std = ((e.get("electricityDetail") or {}).get("estimated") or {}).get("standingCharge")
                plans[name] = (score, _plan("Bord Gáis", re.sub(r"\s+", " ", name).strip(),
                                            rates, round(std, 2) if std else None,
                                            "bordgaisenergy.ie/home/our-plans"))
    return [v[1] for v in plans.values()]


# ---------------------------------------------------------------------------
# Energia — every row of the plans table, name-anchored
# ---------------------------------------------------------------------------

def harvest_energia():
    got = fetch("https://www.energia.ie/energy-plans/electricity", session=S)
    if not got.ok:
        return []
    t = BeautifulSoup(got.text, "lxml").get_text(" ", strip=True)
    out = []
    src = "energia.ie/energy-plans/electricity"

    m = re.search(r"Smart Data.{0,120}?(\d{1,2}\.\d{1,2})\s*c\s*night,\s*"
                  r"(\d{1,2}\.\d{1,2})\s*c\s*day,\s*(\d{1,2}\.\d{1,2})\s*c\s*peak", t, re.I)
    if m:
        n, d, p = (float(m.group(i)) for i in (1, 2, 3))
        out.append(_plan("Energia", "Smart Data",
                         {"day": _eur(d), "night": _eur(n), "peak": _eur(p), "ev": _eur(n)},
                         source=src))
    m = re.search(r"Smart Day/Night.{0,120}?(\d{1,2}\.\d{1,2})\s*c\s*night,\s*"
                  r"(\d{1,2}\.\d{1,2})\s*c\s*day and peak", t, re.I)
    if m:
        n, d = float(m.group(1)), float(m.group(2))
        out.append(_plan("Energia", "Smart Day/Night",
                         {"day": _eur(d), "night": _eur(n), "peak": _eur(d), "ev": _eur(n)},
                         source=src))
    m = re.search(r"EV Smart Drive.{0,120}?(\d{1,2}\.\d{1,2})\s*c\s*EV rate,\s*"
                  r"(\d{1,2}\.\d{1,2})\s*c\s*all other", t, re.I)
    if m:
        ev, o = float(m.group(1)), float(m.group(2))
        out.append(_plan("Energia", "EV Smart Drive",
                         {"day": _eur(o), "night": _eur(o), "peak": _eur(o), "ev": _eur(ev)},
                         source=src))
    m = re.search(r"Smart 24 Hour.{0,120}?(\d{1,2}\.\d{1,2})\s*c/kWh\s*day, night and peak", t, re.I)
    if m:
        r = _eur(float(m.group(1)))
        out.append(_plan("Energia", "Smart 24 Hour",
                         {"day": r, "night": r, "peak": r, "ev": r}, source=src))
    m = re.search(r"Standard Electricity.{0,120}?(\d{1,2}\.\d{1,2})\s*c/kWh\s*24hr", t, re.I)
    if m:
        r = _eur(float(m.group(1)))
        out.append(_plan("Energia", "Standard Electricity",
                         {"day": r, "night": r, "peak": r, "ev": r}, source=src))
    return out


# ---------------------------------------------------------------------------
# SSE — one plan per electricity tariff PDF
# ---------------------------------------------------------------------------

def harvest_sse():
    got = fetch(SSE_OFFERS_URL, session=S)
    if not got.ok:
        return []
    soup = BeautifulSoup(got.text, "lxml")
    pdfs = [urljoin(SSE_OFFERS_URL, a["href"]) for a in soup.find_all("a", href=True)
            if ".pdf" in a["href"].lower() and "/tariffs/" in a["href"].lower()
            and "elec" in a["href"].lower()]
    out = []
    for url in dict.fromkeys(pdfs):
        got2 = fetch(url, session=S)
        if not got2.ok:
            continue
        txt = pdf_text(got2.content)
        title = txt.split("\n")[1].strip() if "\n" in txt else url.rsplit("/", 1)[-1]
        std = _sse_standing(txt, "Urban Smart") or _sse_standing(txt, "Urban Smart EV Max") \
            or _sse_standing(txt, "Urban 24 hr")
        if "evmax" in url.lower():
            r18, r6 = _sse_row(txt, "18h Rate"), _sse_row(txt, "6h Rate")
            if r18 and r6:
                out.append(_plan("SSE Airtricity", title,
                                 {"day": _eur(r18), "night": _eur(r18),
                                  "peak": _eur(r18), "ev": _eur(r6)}, std, url.rsplit("/", 1)[-1]))
            continue
        flat = _sse_row(txt, "Rate (cents/kWh)")
        day = _sse_row(txt, "Day Rate (cents/kWh)♦♦")
        night = _sse_row(txt, "Night Rate (cents/kWh)♦♦")
        peak = _sse_row(txt, "Peak Rate")
        if day and night and peak:
            out.append(_plan("SSE Airtricity", f"{title} (Smart DNP)",
                             {"day": _eur(day), "night": _eur(night),
                              "peak": _eur(peak), "ev": _eur(night)}, std, url.rsplit("/", 1)[-1]))
        if flat:
            out.append(_plan("SSE Airtricity", f"{title} (24hr)",
                             {"day": _eur(flat), "night": _eur(flat),
                              "peak": _eur(flat), "ev": _eur(flat)}, std, url.rsplit("/", 1)[-1]))
    return out


# ---------------------------------------------------------------------------
# Yuno — the homepage price list (standing shared across its plans)
# ---------------------------------------------------------------------------

def harvest_yuno():
    got = fetch(YUNO_URL, session=S)
    if not got.ok:
        return []
    t = BeautifulSoup(got.text, "lxml").get_text(" ", strip=True)
    sc = re.search(r"Urban Standing Charge\D*€\s*[\d,.]+\s*Annually\s*€\s*([\d,.]+)", t, re.I)
    standing = round(float(sc.group(1).replace(",", "")), 2) if sc else None
    ur = re.search(r"24Hr Unit Rate\D*[\d.]+\s*cent/kWh\s*([\d.]+)\s*cent/kWh", t, re.I)
    out = []
    if ur:
        r = _eur(float(ur.group(1)))
        out.append(_plan("Yuno Energy", "Standard Smart 24hr",
                         {"day": r, "night": r, "peak": r, "ev": r}, standing, "yunoenergy.ie"))
    return out


# ---------------------------------------------------------------------------
# Pinergy — the standard price list
# ---------------------------------------------------------------------------

def harvest_pinergy():
    got = fetch(PINERGY_URL, session=S)
    if not got.ok:
        return []
    t = BeautifulSoup(got.text, "lxml").get_text(" ", strip=True)
    euros = [float(x.replace(",", "")) for x in re.findall(r"€\s*([\d,]+\.\d{2})", t)]
    standing = next((round(v, 2) for v in euros if 150.0 <= v <= 450.0), None)
    ur = re.search(r"Unit Rate\D*(\d{2}\.\d{2})", t)
    out = []
    if standing and ur:
        r = _eur(float(ur.group(1)))
        out.append(_plan("Pinergy", "Standard Smart",
                         {"day": r, "night": r, "peak": r, "ev": r}, standing,
                         "pinergy.ie/terms-conditions/tariffs"))
    return out


# ---------------------------------------------------------------------------
# Electric Ireland — the labelled day/night page
# ---------------------------------------------------------------------------

def harvest_electric_ireland():
    got = fetch("https://www.electricireland.ie/residential/electricity-and-gas/"
                "smart-meter-price-plans", session=S)
    if not got.ok:
        return []
    t = BeautifulSoup(got.text, "lxml").get_text(" ", strip=True)
    out = []
    m = re.search(r"Day:[^\d]*[\d.]+\s*-\s*[\d.]+\s*(\d{2}\.\d{2})\s*c(?:(?!Peak:).)*?"
                  r"Night:[^\d]*[\d.]+\s*-\s*[\d.]+\s*(\d{2}\.\d{2})\s*c", t, re.I | re.S)
    if m:
        d, n = _eur(float(m.group(1))), _eur(float(m.group(2)))
        out.append(_plan("Electric Ireland", "Smart Day & Night",
                         {"day": d, "night": n, "peak": d, "ev": n},
                         source="electricireland.ie/.../smart-meter-price-plans"))
    return out


HARVESTERS = {
    "bord_gais": harvest_bord_gais,
    "energia": harvest_energia,
    "sse": harvest_sse,
    "yuno": harvest_yuno,
    "pinergy": harvest_pinergy,
    "electric_ireland": harvest_electric_ireland,
}


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
            print(f"  {p['supplier']:16} {p['type']:5} {p['name'][:42]:42} "
                  f"{p['rates']} standing={p['standing']}")
        catalogue.extend(plans)
    Path("catalogue.json").write_text(json.dumps(catalogue, indent=2, ensure_ascii=False))
    print(f"\nwrote catalogue.json ({len(catalogue)} plans across "
          f"{len({p['supplier'] for p in catalogue})} suppliers)")


if __name__ == "__main__":
    main()
