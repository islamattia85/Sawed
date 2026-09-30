#!/usr/bin/env python3
"""
Tests for the supplier-specific parsers.

Same rule as test_sources.py: nothing here touches the network. Each test feeds
a parser the exact shape the live site served on the day it was written (see the
runner logs behind diagnose_deep.py) and asserts we read the right number into
the right band. A parser that silently starts reading the wrong figure — the way
the old keyword net read a TOU plan's night rate into its day field — fails here
on the commit that breaks it, not eight weeks later on a user's screen.
"""

import pytest

import parsers
from sources import Fetched
from parsers import (
    parse_waterpower, parse_prepaypower,
    parse_energia, parse_pinergy, parse_electric_ireland,
    _bg_entries, _bg_pick, _bg_rates, _sse_row, _sse_standing,
)


def _stub_fetch(monkeypatch, text):
    monkeypatch.setattr(parsers, "fetch",
                        lambda url, session=None: Fetched(url, status=200,
                                                          text=text, kind="ok"))


# ---------------------------------------------------------------------------
# Energia — rate-shape anchoring, not plan-name anchoring
# ---------------------------------------------------------------------------

ENERGIA_TEXT = (
    "Energy Plans Table Plan Best for Meter type Key rate inc. VAT "
    "Smart 24 Hour ... 28.10c/kWh day, night and peak 30% "
    "Smart Data ... 16.91c night, 30.75c day, 34.54c peak 27% "
    "EV Smart Drive ... 9.42c EV rate, 40.16c all other time 10% "
    "Standard Electricity ... 29.86c/kWh 24hr rate 30%"
)


def test_energia_reads_the_time_of_use_bands_into_the_right_fields(monkeypatch):
    _stub_fetch(monkeypatch, ENERGIA_TEXT)
    out = parse_energia(session=None)
    assert out["EN-SMART"]["rates"] == {"day": 0.3075, "night": 0.1691,
                                        "peak": 0.3454, "ev": 0.1691}


def test_energia_reads_the_ev_rate_and_the_all_other_rate(monkeypatch):
    _stub_fetch(monkeypatch, ENERGIA_TEXT)
    out = parse_energia(session=None)
    assert out["EN-EV"]["rates"]["ev"] == 0.0942
    assert out["EN-EV"]["rates"]["day"] == 0.4016


def test_energia_leaves_the_flat_plan_to_the_generic_net(monkeypatch):
    # EN-24 is a single flat rate the net reads correctly; the parser must not
    # claim it (and must not grab the 28.10c Smart 24 Hour rate by mistake).
    _stub_fetch(monkeypatch, ENERGIA_TEXT)
    out = parse_energia(session=None)
    assert "EN-24" not in out


# ---------------------------------------------------------------------------
# Pinergy — the standing charge, not the annual bill beside it
# ---------------------------------------------------------------------------

PINERGY_TEXT = (
    "EAB Table Unit Rate Estimate for Year Standing Charge for Year "
    "Prepayment Charge Public Service Obligation EAB Inc VAT "
    "€ 1,724.00 € 283.47 € 0.00 € 66.99"
)


def test_pinergy_picks_the_standing_charge_out_of_the_euro_figures(monkeypatch):
    _stub_fetch(monkeypatch, PINERGY_TEXT)
    out = parse_pinergy(session=None)
    # €1,724 is the annual bill; €283.47 is the standing charge.
    assert out["PIN-LF"]["standing"] == 283.47


def test_pinergy_shares_the_standing_charge_across_the_lifestyle_plans(monkeypatch):
    _stub_fetch(monkeypatch, PINERGY_TEXT)
    out = parse_pinergy(session=None)
    assert set(out) == {"PIN-LF", "PIN-WFH", "PIN-FAM", "PIN-EV"}
    assert all(v["standing"] == 283.47 for v in out.values())


# ---------------------------------------------------------------------------
# Electric Ireland — day/night is the Nightsaver plan, guarded against peak
# ---------------------------------------------------------------------------

EI_DN_TEXT = ("customers with day night meters Pricing Electricity unit price "
              "Day: 08.00 - 23.00 32.50c per kWh Night: 23.00 - 08.00 16.03c per kWh")

EI_SMART_TEXT = ("smart standard Pricing Day: 08.00 - 17.00 33.00c per kWh "
                 "Peak: 17.00 - 19.00 43.00c per kWh Night: 23.00 - 08.00 17.00c per kWh")


def test_electric_ireland_reads_the_nightsaver_day_and_night(monkeypatch):
    _stub_fetch(monkeypatch, EI_DN_TEXT)
    out = parse_electric_ireland(session=None)
    assert out["EI-NS"]["rates"]["day"] == 0.3250
    assert out["EI-NS"]["rates"]["night"] == 0.1603


def test_electric_ireland_refuses_a_page_that_has_a_peak_window(monkeypatch):
    # A peak band means this is the smart standard plan, not Nightsaver — the
    # parser must not mislabel it.
    _stub_fetch(monkeypatch, EI_SMART_TEXT)
    out = parse_electric_ireland(session=None)
    assert out == {}


def test_electric_ireland_skips_the_smart_block_to_reach_the_nightsaver_one(monkeypatch):
    # The real page lists both plans. Starting at the smart standard Day, the
    # Peak window between its Day and Night blocks the match, so the parser
    # advances to the Nightsaver block and reads its day/night rates — it must
    # not read the smart plan's 33.00c into EI-NS.
    _stub_fetch(monkeypatch, EI_SMART_TEXT + " day night meter " + EI_DN_TEXT)
    out = parse_electric_ireland(session=None)
    assert out["EI-NS"]["rates"]["day"] == 0.3250
    assert out["EI-NS"]["rates"]["night"] == 0.1603


# ---------------------------------------------------------------------------
# Bord Gáis — pick the public New-customer offer out of the catalogue
# ---------------------------------------------------------------------------

BG_CATALOGUE = {
    "products": {"list": {"ELECTRICITY": {"entries": {
        "sf1": {"name": "Smart Standard Electricity Discount", "fuelType": "Single Fuel",
                "offerCode": "May26SSTNewElecOnly", "startDate": "2026-05-20T10:00:00Z",
                "electricityDetail": {"estimated": {"smartRates": {
                    "day": 32.89, "night": 24.28, "peak": 40.04}}}},
        "sf2": {"name": "Smart Standard Electricity Discount", "fuelType": "Single Fuel",
                "offerCode": "Mar24SSTExistingElecOnly", "startDate": "2024-03-01T10:00:00Z",
                "electricityDetail": {"estimated": {"smartRates": {
                    "day": 33.78, "night": 24.93, "peak": 41.12}}}},
        "sf3": {"name": "Fieldsales Employee Smart Standard Electricity Discount",
                "fuelType": "Single Fuel", "offerCode": "Jul25FSSSTNewElec",
                "startDate": "2025-06-20T10:00:00Z",
                "electricityDetail": {"estimated": {"smartRates": {
                    "day": 29.34, "night": 21.65, "peak": 35.71}}}},
    }}}}
}


def test_bord_gais_finds_every_entry_under_entries():
    entries = _bg_entries([BG_CATALOGUE])
    assert len(entries) == 3


def test_bord_gais_picks_the_newest_public_new_customer_offer():
    entries = _bg_entries([BG_CATALOGUE])
    entry = _bg_pick(entries, "Smart Standard Electricity Discount")
    # The New offer from May 2026, not the older Existing one and not the
    # Fieldsales Employee variant (which has a different name).
    assert entry["offerCode"] == "May26SSTNewElecOnly"


def test_bord_gais_reads_the_smart_bands_into_the_right_fields():
    entries = _bg_entries([BG_CATALOGUE])
    entry = _bg_pick(entries, "Smart Standard Electricity Discount")
    assert _bg_rates(entry) == {"day": 0.3289, "night": 0.2428,
                                "peak": 0.4004, "ev": 0.2428}


def test_bord_gais_reads_a_dynamic_plans_fixed_base_rate():
    entry = {"name": "Smart Dynamic Electricity", "fuelType": "Single Fuel",
             "offerCode": "Jun26DynNewElec", "startDate": "2026-06-01T00:00:00Z",
             "electricityDetail": {"estimated": {"base": 16.73, "oBase": 16.73}}}
    assert _bg_rates(entry) == {"day": 0.1673, "night": 0.1673,
                                "peak": 0.1673, "ev": 0.1673}


def test_bord_gais_ignores_an_affinity_or_staff_variant():
    # A name we do not allow-list must not resolve, however its rates look.
    entries = _bg_entries([BG_CATALOGUE])
    assert _bg_pick(entries, "Fieldsales Employee Smart Standard Electricity Discount") \
        is not None  # _bg_pick itself matches by exact name…
    # …but the public map never asks for that name, so parse_bord_gais cannot
    # emit it. The allow-list is the guard, checked here:
    assert "Fieldsales Employee Smart Standard Electricity Discount" not in parsers.BG_NAMES


# ---------------------------------------------------------------------------
# SSE — the DD&eBill inc-VAT column out of a five-tier price row
# ---------------------------------------------------------------------------

SSE_PDF_TEXT = (
    "24 Hour Meter Inc. Smart\n"
    "37.73 41.13 26.41 28.79 29.05 31.66 31.32 34.14 33.96 37.02\n"
    "Rate (cents/kWh)\n"
    "Urban Smart 66.32 72.29 € 242.07 € 263.86\n"
)


def test_sse_takes_the_dd_ebill_inc_vat_figure():
    # Ten numbers: five payment tiers, Ex/Inc each. The advertised offer is the
    # DD&eBill Inc-VAT column — the 4th number.
    assert _sse_row(SSE_PDF_TEXT, "Rate (cents/kWh)") == 28.79


def test_sse_reads_the_urban_standing_charge_in_euro_per_year():
    assert _sse_standing(SSE_PDF_TEXT, "Urban Smart") == 263.86


# ---------------------------------------------------------------------------
# Embedded-registry sync — keep main.js in step with tariffs.json
# ---------------------------------------------------------------------------

from pathlib import Path
from scrape_tariffs import sync_embedded_tariffs

MAIN_JS_FIXTURE = '''const EMBEDDED_TARIFFS = [
  {
    id:"EI-24",
    supplier:"Electric Ireland",
    plan:"Home Electric+ 24hr",
    type:"flat",
    rates:{day:0.2981, night:0.2981, peak:0.2981, ev:0.2981},
    windows:{ ev:null },
    standing:250.77, exit:50, length:12, green:false, export_rate:0.195,
    verified_date:"2026-08-25",
    notes:"whatever"
  },
  {
    id:"EN-SMART",
    supplier:"Energia",
    plan:"Smart Data",
    type:"tou",
    rates:{day:0.3075, night:0.1691, peak:0.3454, ev:0.1691},
    windows:{ peak:[17,19], night:[23,8], ev:null },
    standing:265.01, exit:50, length:12, green:true, export_rate:0.185,
    verified_date:"2026-08-25",
    notes:"whatever"
  }
];'''


def test_sync_rewrites_rates_standing_and_verified_date(tmp_path):
    p = tmp_path / "main.js"
    p.write_text(MAIN_JS_FIXTURE)
    tariffs = [
        {"id": "__meta__"},
        {"id": "EI-24", "rates": {"day": 0.3055, "night": 0.3055, "peak": 0.3055,
                                  "ev": 0.3055}, "standing": 250.77,
         "verified_date": "2026-09-14"},
        {"id": "EN-SMART", "rates": {"day": 0.3075, "night": 0.1691, "peak": 0.3454,
                                     "ev": 0.1691}, "standing": 255.29,
         "verified_date": "2026-09-14"},
    ]
    n = sync_embedded_tariffs(p, tariffs)
    out = p.read_text()
    assert n == 2
    assert "rates:{day:0.3055, night:0.3055, peak:0.3055, ev:0.3055}" in out
    assert "standing:255.29" in out
    assert out.count('verified_date:"2026-09-14"') == 2
    # windows block must be untouched
    assert "windows:{ peak:[17,19], night:[23,8], ev:null }" in out


def test_sync_skips_plans_the_bundle_does_not_carry(tmp_path):
    p = tmp_path / "main.js"
    p.write_text(MAIN_JS_FIXTURE)
    n = sync_embedded_tariffs(p, [{"id": "YN-24", "rates": {"day": 0.25},
                                   "standing": 219.22, "verified_date": "2026-09-14"}])
    assert n == 0
    assert p.read_text() == MAIN_JS_FIXTURE


# ---------------------------------------------------------------------------
# Waterpower — table per tariff; figures in euro despite the c/kwh label
# (markup as read from waterpower.ie/current-electricity-rates on 30 Sep 2026)
# ---------------------------------------------------------------------------

def _table(title, rows):
    body = "".join(f"<tr><td>{a}</td><td>{b}</td><td>{c}</td></tr>" for a, b, c in rows)
    return f"<table><tr><th>{title}</th><th>Ex.Vat</th><th>Incl.Vat</th></tr>{body}</table>"


WATERPOWER_HTML = "".join([
    _table("Domestic 24 Hour Urban", [
        ("Unit Rate c/kwh (Post Bill Only)", "0.2926", "0.3190"),
        ("Unit Rate c/kwh (E-Bill Only)", "0.2883", "0.3142"),
        ("Standing Charge Per Annum", "€226.30", "€246.67"),
        ("PSO Levy *", "€17.52", "€19.10")]),
    _table("Domestic 24 Hour Rural", [
        ("Unit Rate c/kwh (E-Bill Only)", "0.2883", "0.3142"),
        ("Standing Charge Per Annum", "€295.65", "€322.26")]),
    _table("Domestic Day/Night (Post Billing) Urban", [
        ("Unit Day Rate c/kwh (Post Bill Only)", "0.3069", "0.3346"),
        ("Unit Night Rate c/kwh (Post Bill only)", "0.2366", "0.2579"),
        ("Standing Charge Per Annum", "€226.30", "€246.67")]),
    _table("Domestic Day/Night (E-Billing) Urban", [
        ("Unit Day Rate c/kwh", "0.3024", "0.3296"),
        ("Unit Night Rate c/kwh", "0.2331", "0.2541"),
        ("Standing Charge Per Annum", "€226.30", "€246.67")]),
])


def test_waterpower_reads_the_ebill_inc_vat_urban_24h(monkeypatch):
    _stub_fetch(monkeypatch, WATERPOWER_HTML)
    out = parse_waterpower(session=None)
    assert out["WP-24"]["rates"]["day"] == 0.3142        # e-bill, not post (0.3190)
    assert out["WP-24"]["standing"] == 246.67            # urban, not rural (322.26)


def test_waterpower_reads_the_ebill_day_night_not_the_post_billing_table(monkeypatch):
    _stub_fetch(monkeypatch, WATERPOWER_HTML)
    r = parse_waterpower(session=None)["WP-DN"]["rates"]
    assert (r["day"], r["night"]) == (0.3296, 0.2541)


# ---------------------------------------------------------------------------
# PrePayPower — units ex VAT, daily fixed charges inc VAT
# (markup as read from prepaypower.ie estimated-annual-bill-faqs, dated 1 May 2026)
# ---------------------------------------------------------------------------

PPP_HEAD = ["Tariff", "24 H Unit Rate", "Day Unit Rate", "Night Unit Rate", "Peak Unit Rate",
            "CRU Avg Elec Consumption", "Standing Charge", "Service Charge", "PSO*", "PSO*",
            "EAB", "EAB"]
PPP_ROWS = [
    ["24 Hr Urban Standard", "30.84c", "", "", "", "4,200 kwh", "93.89c", "45.04c", "4.80c", "5.23c", "€1,777.60", "€1,937.81"],
    ["24 Hr Rural Standard", "30.84c", "", "", "", "4,200 kwh", "€1.2269", "45.04c", "4.80c", "5.23c", "€1,874.07", "€2,042.96"],
    ["Urban Nightsaver Standard", "", "34.15c", "16.86c", "", "4,200 kwh", "€1.2501", "45.04c", "4.80c", "5.23c", "€1,745.37", "€1,902.45"],
    ["Urban Time of Use Day/Night/Peak", "", "34.12c", "17.69c", "38.34c", "4,200 kwh", "93.89c", "45.04c", "4.80c", "5.23c", "€1,685.00", "€1,836.65"],
]
PPP_HTML = "<table>" + "".join(
    "<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>"
    for r in [["", "Exc VAT"] * 6, PPP_HEAD] + PPP_ROWS) + "</table>"


def test_prepaypower_adds_vat_to_units_but_not_to_the_fixed_charges(monkeypatch):
    _stub_fetch(monkeypatch, PPP_HTML)
    out = parse_prepaypower(session=None)
    assert out["PPP-24"]["rates"]["day"] == round(30.84 * 1.09 / 100, 4)   # 0.3362
    # standing 93.89c + service 45.04c per day, already inc VAT, for a year
    assert out["PPP-24"]["standing"] == round((0.9389 + 0.4504) * 365, 2)


def test_prepaypower_split_reproduces_the_suppliers_own_estimated_bill(monkeypatch):
    # The reason the VAT split is trusted: it rebuilds PrePayPower's published
    # €1,937.81 estimated annual bill (4,200 kWh + PSO 5.23c/day) to within €1.
    _stub_fetch(monkeypatch, PPP_HTML)
    p = parse_prepaypower(session=None)["PPP-24"]
    eab = 4200 * p["rates"]["day"] + p["standing"] + 0.0523 * 365
    assert abs(eab - 1937.81) < 1.0


def test_prepaypower_reads_the_urban_rows_into_the_right_bands(monkeypatch):
    _stub_fetch(monkeypatch, PPP_HTML)
    out = parse_prepaypower(session=None)
    assert out["PPP-NS"]["rates"]["night"] == round(16.86 * 1.09 / 100, 4)
    assert out["PPP-NS"]["standing"] == round((1.2501 + 0.4504) * 365, 2)   # €-per-day cell
    tou = out["PPP-TOU"]["rates"]
    assert (tou["day"], tou["night"], tou["peak"]) == (
        round(34.12 * 1.09 / 100, 4), round(17.69 * 1.09 / 100, 4), round(38.34 * 1.09 / 100, 4))
    assert "PPP-24-RURAL" not in out and len(out) == 3
