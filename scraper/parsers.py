#!/usr/bin/env python3
"""
Supplier-specific parsers.

The generic discover→attribute pipeline in scrape_tariffs.py is the safety net:
it reads *any* page and guesses. It is also why coverage sat at 24%. Two things
defeat it. Bord Gáis ships tens of thousands of JSON rate candidates and a
keyword window cannot tell the public "Smart Standard Electricity Discount" from
the staff "Fieldsales Employee" variant three keys away. And a time-of-use plan
quoted as "16.91c night, 30.75c day, 34.54c peak" is read left-to-right, so the
night rate lands in the day field — every TOU plan mispriced with no error.

So the suppliers whose markup we actually understand get a hand-written parser
here, keyed off a URL confirmed by hand to serve prices (see diagnose_deep.py,
run from a CI runner because the sites are unreachable from the dev container).
Each parser returns, per plan id we recognise, the rates and/or standing charge
it could read:

    {plan_id: {"rates": {"day":.., "night":.., "peak":.., "ev":..} | None,
               "standing": float | None}}

Rates are euro per kWh; standing is euro per year. Both are candidates, not
verdicts — scrape_tariffs validates every one against the current value within
tolerance before it changes anything, and a human still reads the diff. A parser
that reads nothing returns {} and the generic net runs behind it.

The convention, so the numbers mean one thing:
  * VAT-inclusive, because that is the price a person pays and what the app
    ranks on;
  * the standard/new-customer offer on direct debit + eBill where a supplier
    tiers by payment method — that is what a switcher signs up to;
  * urban standing charge where it splits urban/rural, the majority meter.
"""

from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

from sources import fetch, embedded_json, walk, pdf_text


def _eur_kwh(cent: float) -> float:
    return round(cent / 100.0, 4)


def _text_of(html: str) -> str:
    return BeautifulSoup(html, "lxml").get_text(" ", strip=True)


# ---------------------------------------------------------------------------
# Energia — a clean prose table on /energy-plans/electricity
#
#   Smart 24 Hour ... 28.10c/kWh day, night and peak ...
#   Smart Data    ... 16.91c night, 30.75c day, 34.54c peak ...
#   Smart Day/Night ... 17.34c night, 35.19c day and peak ...
#   EV Smart Drive ... 9.42c EV rate, 40.16c all other time ...
#   Standard Electricity ... 29.86c/kWh 24hr rate ...
#
# Each rate carries its own band word next to it, so we read the labelled figure
# rather than the first number after the plan name.
# ---------------------------------------------------------------------------

ENERGIA_URL = "https://www.energia.ie/energy-plans/electricity"


def parse_energia(session: requests.Session) -> dict:
    got = fetch(ENERGIA_URL, session=session)
    if not got.ok:
        return {}
    text = _text_of(got.text)
    out: dict = {}

    # The table quotes each rate next to its band, in a fixed order per row.
    # Anchoring on the rate SHAPE — "16.91c night, 30.75c day, 34.54c peak" —
    # rather than the plan name avoids the nav menu, which repeats every plan
    # name as a link before the table and defeated a name-anchored search. EN-24
    # (a single flat rate) is left to the generic net, which reads it correctly;
    # the parser only claims the time-of-use rows the net gets wrong.
    m = re.search(r"(\d{1,2}\.\d{1,2})\s*c\s*night,\s*"
                  r"(\d{1,2}\.\d{1,2})\s*c\s*day,\s*"
                  r"(\d{1,2}\.\d{1,2})\s*c\s*peak", text, re.I)
    if m:
        night, day, peak = (float(m.group(i)) for i in (1, 2, 3))
        out["EN-SMART"] = {"rates": {"day": _eur_kwh(day),
                                     "night": _eur_kwh(night),
                                     "peak": _eur_kwh(peak),
                                     "ev": _eur_kwh(night)},
                           "standing": None}

    m = re.search(r"(\d{1,2}\.\d{1,2})\s*c\s*EV rate,\s*"
                  r"(\d{1,2}\.\d{1,2})\s*c\s*all other", text, re.I)
    if m:
        ev, other = float(m.group(1)), float(m.group(2))
        o = _eur_kwh(other)
        out["EN-EV"] = {"rates": {"day": o, "night": o, "peak": o,
                                  "ev": _eur_kwh(ev)},
                        "standing": None}
    return out


# ---------------------------------------------------------------------------
# Bord Gáis — structured JSON on the plan chooser
#
# The page ships a Salesforce catalogue: products.list.<FUEL>.entries is a dict
# of offer variants, each with a plain name, an offerCode, a validity window and
# either smartRates {day,night,peak,…} or a flat unitRate. Dozens share a name
# because every payment method and affinity partner is a separate entry, so we
# pin to the public offer: an exact allow-listed name, single fuel, an offerCode
# marked New, currently valid, most recent start.
# ---------------------------------------------------------------------------

BG_SMART_URL = ("https://www.bordgaisenergy.ie/home/our-plans"
                "?fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES")
BG_FLAT_URL = ("https://www.bordgaisenergy.ie/home/our-plans"
               "?fuelType=ELECTRICITY&smartMeter=SMARTMETER_NO")

#: exact public plan name → our id. Affinity/staff variants (Arcadian, EMC,
#: Fieldsales Employee, …) are excluded by not being in this map.
#: BG-EV is deliberately absent: the catalogue's EV plan carries only the
#: standard smartRates bands, not the deep overnight EV rate the plan is bought
#: for, so reading it here would price the EV band at the ordinary night rate.
#: It stays a manual entry until the feed exposes the EV window.
BG_NAMES = {
    "Electricity Discount": "BG-24",
    "Smart Standard Electricity Discount": "BG-TOU",
}


def _bg_entries(blobs: list) -> list[dict]:
    """Every product entry dict, wherever it sits under a '.entries' key."""
    entries: list[dict] = []

    def rec(node, path=""):
        if isinstance(node, dict):
            if path.endswith(".entries"):
                for sfid, entry in node.items():
                    if isinstance(entry, dict):
                        entries.append(entry)
            for k, v in node.items():
                rec(v, f"{path}.{k}" if path else k)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                rec(v, f"{path}[{i}]")

    for b in blobs:
        rec(b)
    return entries


def _bg_pick(entries: list[dict], name: str) -> Optional[dict]:
    """The current public New-customer offer for one plan name."""
    cands = [e for e in entries
             if e.get("name") == name
             and e.get("fuelType", "").lower().startswith("single")]
    if not cands:
        return None
    new = [e for e in cands if "new" in str(e.get("offerCode", "")).lower()]
    pool = new or cands
    # most recent start date wins
    pool.sort(key=lambda e: str(e.get("startDate", "")), reverse=True)
    return pool[0]


def _bg_rates(entry: dict) -> Optional[dict]:
    est = ((entry.get("electricityDetail") or {}).get("estimated") or {})
    sr = est.get("smartRates") or {}
    if sr.get("day") and sr.get("night") and sr.get("peak"):
        return {"day": _eur_kwh(sr["day"]), "night": _eur_kwh(sr["night"]),
                "peak": _eur_kwh(sr["peak"]), "ev": _eur_kwh(sr["night"])}
    flat = est.get("flatRate") or est.get("unitRate")
    if flat:
        r = _eur_kwh(flat)
        return {"day": r, "night": r, "peak": r, "ev": r}
    return None


def parse_bord_gais(session: requests.Session) -> dict:
    out: dict = {}
    for url in (BG_SMART_URL, BG_FLAT_URL):
        got = fetch(url, session=session)
        if not got.ok:
            continue
        entries = _bg_entries(embedded_json(got.text))
        for name, plan_id in BG_NAMES.items():
            if plan_id in out:
                continue
            entry = _bg_pick(entries, name)
            if not entry:
                continue
            rates = _bg_rates(entry)
            if rates:
                out[plan_id] = {"rates": rates, "standing": None}
    return out


# ---------------------------------------------------------------------------
# SSE Airtricity — one price-sheet PDF per plan under /assets/Tariffs/ROI/Current
#
# The grid is: five payment tiers (Standard, then 30/23/17/10% for DD&eBill,
# DD&Post, NonDD&eBill, NonDD&Post), each Ex/Inc VAT → ten numbers a row. We
# take the DD&eBill Inc-VAT column (the advertised new-customer offer), which is
# the 4th number on each rate row.
# ---------------------------------------------------------------------------

SSE_OFFERS_URL = ("https://www.sseairtricity.com/ie/home/help-centre/"
                  "our-tariffs/current-offers")


def _sse_row(text: str, label: str) -> Optional[float]:
    """Inc-VAT DD&eBill figure (4th number) on the rate row ending in `label`."""
    m = re.search(r"((?:\d{1,2}\.\d{2}\s+){4,}\d{1,2}\.\d{2})\s*\n?\s*" +
                  re.escape(label), text)
    if not m:
        return None
    nums = [float(x) for x in re.findall(r"\d{1,2}\.\d{2}", m.group(1))]
    return nums[3] if len(nums) >= 4 else None


def _sse_standing(text: str, meter: str) -> Optional[float]:
    m = re.search(re.escape(meter) + r"[^€]*€\s*[\d.]+\s*€\s*([\d.]+)", text)
    return round(float(m.group(1)), 2) if m else None


def parse_sse(session: requests.Session) -> dict:
    got = fetch(SSE_OFFERS_URL, session=session)
    if not got.ok:
        return {}
    soup = BeautifulSoup(got.text, "lxml")
    pdfs = [urljoin(SSE_OFFERS_URL, a["href"]) for a in soup.find_all("a", href=True)
            if ".pdf" in a["href"].lower() and "/tariffs/" in a["href"].lower()
            and "elec" in a["href"].lower()]
    out: dict = {}
    for url in pdfs:
        got2 = fetch(url, session=session)
        if not got2.ok:
            continue
        txt = pdf_text(got2.content)
        low = url.lower()

        if "evmax" in low:
            r18 = _sse_row(txt, "18h Rate")
            r6 = _sse_row(txt, "6h Rate")
            if r18 and r6:
                out["SSE-EVMAX"] = {
                    "rates": {"day": _eur_kwh(r18), "night": _eur_kwh(r18),
                              "peak": _eur_kwh(r18), "ev": _eur_kwh(r6)},
                    "standing": _sse_standing(txt, "Urban Smart EV Max")}
        elif "1yr-elec-30" in low or "1yr-elec-15" in low.replace("-weekend", ""):
            # The standard 1-year electricity sheet carries both the flat 24hr
            # smart rate and the smart day/night/peak rows.
            flat = _sse_row(txt, "Rate (cents/kWh)")
            day = _sse_row(txt, "Day Rate (cents/kWh)♦♦") or _sse_row(txt, "Day Rate")
            night = _sse_row(txt, "Night Rate (cents/kWh)♦♦")
            peak = _sse_row(txt, "Peak Rate")
            std = _sse_standing(txt, "Urban Smart")
            if flat and "SSE-EVDAY" not in out:
                out["SSE-EVDAY"] = {"rates": {"day": _eur_kwh(flat),
                                              "night": _eur_kwh(flat),
                                              "peak": _eur_kwh(flat),
                                              "ev": _eur_kwh(flat)},
                                    "standing": std}
            if day and night and peak and "SSE-DNP" not in out:
                out["SSE-DNP"] = {"rates": {"day": _eur_kwh(day),
                                            "night": _eur_kwh(night),
                                            "peak": _eur_kwh(peak),
                                            "ev": _eur_kwh(night)},
                                  "standing": std}
    return out


# ---------------------------------------------------------------------------
# Pinergy — a regulator-style table on /terms-conditions/tariffs/
#
# One standard price list: a unit rate and a standing charge, both cent/euro
# figures in a labelled table. The standing charge is shared across Pinergy's
# lifestyle plans, so reading it verifies each of them; the unit rate anchors the
# standard plan.
# ---------------------------------------------------------------------------

PINERGY_URL = "https://www.pinergy.ie/terms-conditions/tariffs/"


def parse_pinergy(session: requests.Session) -> dict:
    got = fetch(PINERGY_URL, session=session)
    if not got.ok:
        return {}
    text = _text_of(got.text)
    out: dict = {}
    # The table sits "Standing Charge for Year" next to an "Estimated Annual
    # Bill", so a €-figure right after the label is the €1,700 bill, not the
    # charge. Pick the euro amount in the range an annual standing charge can
    # actually take (a bill and a unit rate both fall outside it), which is the
    # one value on the page that can only be the standing charge.
    euros = [float(x.replace(",", "")) for x in re.findall(r"€\s*([\d,]+\.\d{2})", text)]
    standing = next((round(v, 2) for v in euros if 150.0 <= v <= 450.0), None)
    if standing:
        # One standing charge, shared across the lifestyle plans — reading it
        # re-confirms all four at once.
        for pid in ("PIN-LF", "PIN-WFH", "PIN-FAM", "PIN-EV"):
            out[pid] = {"rates": None, "standing": standing}
    return out


# ---------------------------------------------------------------------------
# Electric Ireland — labelled prose on the day/night price plan
#
#   Day: 08.00 - 23.00 32.50c per kWh  Night: 23.00 - 08.00 16.03c per kWh
#
# Two clock windows and no peak band: this is the Nightsaver (day/night meter)
# plan, EI-NS — not the smart standard plan, which carries a third peak rate
# between 5 and 7pm. The generic net reads the smart standard plan by keyword;
# this reads the one with the cleanly labelled clock windows, which the net's
# left-to-right rate scan gets wrong.
# ---------------------------------------------------------------------------

EI_SMART_URL = ("https://www.electricireland.ie/residential/"
                "electricity-and-gas/smart-meter-price-plans")


def parse_electric_ireland(session: requests.Session) -> dict:
    got = fetch(EI_SMART_URL, session=session)
    if not got.ok:
        return {}
    text = _text_of(got.text)
    out: dict = {}
    # The page lists several plans, so the guard has to be local: match a Day
    # rate followed by a Night rate with NO Peak window between them. That is
    # the Nightsaver (day/night meter) plan. The smart standard plan puts a Peak
    # window between its Day and Night, so this pattern skips past it to the
    # nightsaver block rather than mislabelling smart standard as Nightsaver.
    m = re.search(
        r"Day:[^\d]*[\d.]+\s*-\s*[\d.]+\s*(\d{2}\.\d{2})\s*c"
        r"(?:(?!Peak:).)*?"
        r"Night:[^\d]*[\d.]+\s*-\s*[\d.]+\s*(\d{2}\.\d{2})\s*c",
        text, re.I | re.S)
    if m:
        d, n = _eur_kwh(float(m.group(1))), _eur_kwh(float(m.group(2)))
        out["EI-NS"] = {"rates": {"day": d, "night": n, "peak": d, "ev": n},
                        "standing": None}
    return out


SUPPLIER_PARSERS = {
    "Bord Gáis Energy": parse_bord_gais,
    "Energia": parse_energia,
    "SSE Airtricity": parse_sse,
    "Pinergy": parse_pinergy,
    "Electric Ireland": parse_electric_ireland,
}
