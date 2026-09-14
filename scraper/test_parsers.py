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
