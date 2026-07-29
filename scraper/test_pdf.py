#!/usr/bin/env python3
"""
Reading SSE Airtricity's price-list PDFs.

The fixtures are the real extracted text of the four current price lists, taken
verbatim from a runner on 29 July 2026 (the sites are unreachable from CI, and
pdfplumber's text layout is what the parser actually sees). If SSE reissues a
card in a new shape these break loudly, which is the point: a silent parser is
how this scraper spent eight weeks reporting stale rates as fresh.

Every expected number here was read by eye from the published tables, so a
regression in column choice or VAT handling fails against a figure a person
checked, not against the parser's own output.
"""

import pytest

from sources import (
    parse_rate_table, parse_standing_table, parse_export_cent, PRICE_COLUMN,
)
from scrape_tariffs import sse_pdf_updates, apply_updates


# The 1 Year Home Electricity card (discounts 30/23/17/10).
ELEC = """SSE Airtricity Domestic Electricity Tariffs
1 Year Home Electricity
SSE Airtricity 30% 23% 17% 10%
Electricity Standard DD & eBill* DD & Post* Non DD & eBill* Non DD & Post*
Ex. VAT Inc. VAT Ex. VAT Inc. VAT Ex. VAT Inc. VAT Ex. VAT Inc. VAT Ex. VAT Inc. VAT
24 Hour Meter Inc. Smart◊
37.73 41.13 26.41 28.79 29.05 31.66 31.32 34.14 33.96 37.02
Rate (cents/kWh)
Nightsaver Meter
38.23 41.67 26.76 29.17 29.44 32.09 31.73 34.59 34.41 37.51
Day Rate (cents/kWh)♦
Nightsaver Meter
24.46 26.66 17.12 18.66 18.83 20.52 20.30 22.13 22.01 23.99
Night Rate (cents/kWh)♦
Smart Meter
39.93 43.52 27.95 30.47 30.75 33.52 33.14 36.12 35.94 39.17
Day Rate (cents/kWh)♦♦
Smart Meter
25.66 27.97 17.96 19.58 19.76 21.54 21.30 23.22 23.09 25.17
Night Rate (cents/kWh)♦♦
Smart Meter
44.72 48.74 31.30 34.12 34.43 37.53 37.12 40.46 40.25 43.87
Peak Rate (cents/kWh)♦♦
From 1 July 2024, all eligible customers with Microgen will receive a standard clean export tariff of 19.5 cent per kWh,
payable four times a year.
Standing Charges (cent per day) (euro per year)
Electricity Meter Ex. VAT Inc. VAT Ex. VAT Inc. VAT
Urban 24 hr 66.32 72.29 € 242.07 € 263.86
Rural 24 hr 83.25 90.74 € 303.86 € 331.20
Urban Nightsaver 85.20 92.87 € 310.98 € 338.98
Rural Nightsaver 103.76 113.10 € 378.72 € 412.82
Urban Smart 66.32 72.29 € 242.07 € 263.86
Rural Smart 83.25 90.74 € 303.86 € 331.20
1YR-ELEC-30-V6
"""

# The 1 Year Smart EV Max card (discounts 20/16/10/6).
EVMAX = """SSE Airtricity Domestic Electricity Tariffs
1 Year Smart EV Max Electricity
SSE Airtricity 20% 16% 10% 6%
Electricity Standard DD & eBill* DD & Post* Non DD & eBill* Non DD & Post*
Ex. VAT Inc. VAT Ex. VAT Inc. VAT Ex. VAT Inc. VAT Ex. VAT Inc. VAT Ex. VAT Inc. VAT
Smart EV Max
44.24 48.22 35.39 38.58 37.16 40.50 39.82 43.40 41.59 45.33
18h Rate (cents/kWh)
Smart EV Max
15.90 17.33 12.72 13.86 13.36 14.56 14.31 15.60 14.95 16.30
6h Rate (cents/kWh)
From 1 July 2024, all eligible customers with Microgen will receive a standard clean export tariff of 19.5 cent per kWh,
payable four times a year.
Standing Charges (cent per day) (euro per year)
Electricity Meter Ex. VAT Inc. VAT Ex. VAT Inc. VAT
Urban Smart EV Max 89.79 97.87 € 327.73 € 357.23
Rural Smart EV Max 101.08 110.18 € 368.94 € 402.16
1YR-ELEC-20-EVMax-V2
"""

# The gas-only card: no electricity rows, so it must leave the elec plans alone.
GAS = """SSE Airtricity Domestic Gas Tariffs
1 Year Home Gas
SSE Airtricity 16% 12% 6% 2%
Standard DD & eBill* DD & Post* Non DD & eBill* Non DD & Post*
Gas
Ex. VAT Inc. VAT Ex. VAT Inc. VAT Ex. VAT Inc. VAT Ex. VAT Inc. VAT Ex. VAT Inc. VAT
10.44 11.38 8.77 9.56 9.19 10.02 9.81 10.69 10.23 11.15
Standing Charges
(cent per day) (euro per year)
Gas Meter Ex. VAT Inc. VAT Ex. VAT Inc. VAT
Gas 38.28 41.73 € 139.72 € 152.31
1YR-GAS-16-V1
"""


def _plan(pid, ptype, rates, standing):
    return {"id": pid, "type": ptype, "rates": dict(rates), "standing": standing,
            "export_ceg": None}


# ── The column the whole thing hinges on ──────────────────────────────────

def test_the_stored_column_is_dd_and_post_inc_vat():
    # If this constant ever changes, every SSE rate shifts. It is DD & Post Inc.
    # VAT because that is the basis the existing tariffs.json figures were on.
    assert PRICE_COLUMN == ("DD & Post", "inc")


# ── The table parser ──────────────────────────────────────────────────────

def test_rate_rows_are_read_with_their_meter_and_band():
    rows = parse_rate_table(ELEC)
    flat = [r for r in rows if r["kind"] == "flat"]
    assert flat and "24 Hour" in flat[0]["meter"]
    # DD & Post Inc. VAT for the 24-hour row is 31.66c.
    assert flat[0]["cents"] == pytest.approx(31.66)

    smart_peak = [r for r in rows if r["kind"] == "peak" and r["meter"] == "Smart Meter"]
    assert smart_peak and smart_peak[0]["cents"] == pytest.approx(37.53)


def test_the_ev_windows_are_distinguished():
    rows = parse_rate_table(EVMAX)
    r18 = next(r for r in rows if r["kind"] == "18h")
    r6 = next(r for r in rows if r["kind"] == "6h")
    assert r18["cents"] == pytest.approx(40.50)   # DD & Post Inc. VAT, 18h
    assert r6["cents"] == pytest.approx(14.56)     # DD & Post Inc. VAT, 6h


def test_standing_is_the_inc_vat_euro_per_year():
    st = parse_standing_table(ELEC)
    assert st["urban 24 hr"] == pytest.approx(263.86)
    assert st["urban smart"] == pytest.approx(263.86)
    assert st["rural nightsaver"] == pytest.approx(412.82)
    assert parse_standing_table(EVMAX)["urban smart ev max"] == pytest.approx(357.23)


def test_the_export_rate_is_read():
    assert parse_export_cent(ELEC) == pytest.approx(0.195)
    assert parse_export_cent("nothing about export here") is None


# ── Attribution to our plan ids ───────────────────────────────────────────

def test_the_flat_plan_takes_one_rate_for_every_band():
    existing = {"SSE-EVDAY": True, "SSE-DNP": True, "SSE-EVMAX": True}
    u = sse_pdf_updates(ELEC, existing)["SSE-EVDAY"]
    assert u["_scraped_day_rate"] == pytest.approx(0.3166)
    assert u["_scraped_standing"] == pytest.approx(263.86)
    assert u["_scraped_export"] == pytest.approx(0.195)
    assert u["_trusted"] is True


def test_the_time_of_use_plan_takes_three_distinct_bands():
    existing = {"SSE-EVDAY": True, "SSE-DNP": True, "SSE-EVMAX": True}
    u = sse_pdf_updates(ELEC, existing)["SSE-DNP"]
    assert u["_scraped_day_rate"] == pytest.approx(0.3352)    # Smart Day, DD&Post inc
    assert u["_scraped_night_rate"] == pytest.approx(0.2154)  # Smart Night
    assert u["_scraped_peak_rate"] == pytest.approx(0.3753)   # Smart Peak
    assert u["_scraped_ev_rate"] == pytest.approx(0.2154)     # ev tracks night


def test_the_ev_plan_takes_the_18h_day_and_6h_night():
    existing = {"SSE-EVMAX": True}
    u = sse_pdf_updates(EVMAX, existing)["SSE-EVMAX"]
    assert u["_scraped_day_rate"] == pytest.approx(0.4050)
    assert u["_scraped_ev_rate"] == pytest.approx(0.1456)
    assert u["_scraped_standing"] == pytest.approx(357.23)


def test_a_gas_card_touches_no_electricity_plan():
    existing = {"SSE-EVDAY": True, "SSE-DNP": True, "SSE-EVMAX": True}
    assert sse_pdf_updates(GAS, existing) == {}


def test_a_plan_we_do_not_carry_is_not_invented():
    # Only the electricity card, but we carry none of its plans.
    assert sse_pdf_updates(ELEC, {"SOMETHING-ELSE": True}) == {}


# ── The trusted-value path through apply_updates ──────────────────────────

def test_a_table_value_may_move_more_than_a_prose_one():
    # SSE-EVDAY currently holds 31.52c; the card says 31.66c — a rounding-level
    # move that applies. But even an 8% move from a labelled table column is
    # accepted where the same move from prose would be rejected.
    plans = [_plan("SSE-EVDAY", "flat",
                   {"day": 0.3152, "night": 0.3152, "peak": 0.3152, "ev": 0.3152}, 240.97)]
    upd = {"SSE-EVDAY": {"_scraped_day_rate": 0.2879, "_trusted": True,
                         "verified_date": "2026-07-29"}}
    out, changes = apply_updates(plans, upd)
    assert out[0]["rates"]["day"] == pytest.approx(0.2879)
    assert out[0].get("verified_date") == "2026-07-29"
    assert changes >= 1


def test_a_catastrophic_column_misread_is_still_caught():
    # Picking the Standard column (41.13c) over the discounted one (~31c) is a
    # ~40% jump — beyond even the trusted band, so it is rejected and the plan
    # is NOT stamped verified.
    plans = [_plan("SSE-EVDAY", "flat",
                   {"day": 0.3152, "night": 0.3152, "peak": 0.3152, "ev": 0.3152}, 240.97)]
    upd = {"SSE-EVDAY": {"_scraped_day_rate": 0.4113, "_trusted": True,
                         "verified_date": "2026-07-29"}}
    out, _ = apply_updates(plans, upd)
    assert out[0]["rates"]["day"] == pytest.approx(0.3152)     # unchanged
    assert "verified_date" not in out[0]                       # not marked fresh


def test_a_rejected_day_rate_leaves_the_bands_and_the_stamp_alone():
    # If the anchor rate will not apply, a time-of-use plan must not be left with
    # a fresh night rate and a stale, mismatched day rate.
    plans = [_plan("SSE-DNP", "tou",
                   {"day": 0.20, "night": 0.19, "peak": 0.40, "ev": 0.19}, 302.48)]
    upd = {"SSE-DNP": {"_scraped_day_rate": 0.3352, "_scraped_night_rate": 0.2154,
                       "_scraped_peak_rate": 0.3753, "_trusted": True,
                       "verified_date": "2026-07-29"}}
    out, _ = apply_updates(plans, upd)
    # day 0.20 → 0.3352 is a 68% jump — rejected; nothing else should have moved.
    assert out[0]["rates"]["day"] == pytest.approx(0.20)
    assert out[0]["rates"]["night"] == pytest.approx(0.19)
    assert "verified_date" not in out[0]
