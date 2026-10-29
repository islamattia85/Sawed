"""The recipe reader: a plan's figures come back from a captured page exactly."""
import json

import verify_sources as vs

PAGE = {"url": "https://example.ie/prices", "text": "\n".join([
    "Home", "EV Plan", "24hr Urban", "Ex VAT", "Inc VAT",
    "24Hr Unit Rate*", "33.67 cent/kWh", "36.70 cent/kWh",
    "EV 2am - 6am*", "11.11 cent/kWh", "12.11 cent/kWh",
    "Urban Standing Charge*", "€306.60 Annually", "€334.19 Annually",
    "Day Unit Price 8am to 11pm Everyday", "42.02", "45.80",
])}
PAGES = {vs.norm_url(PAGE["url"]): PAGE}


def test_reads_inc_vat_column_under_its_heading():
    src = {"url": "https://www.example.ie/prices/", "anchor": ["EV Plan", "24hr Urban"], "col": 2,
           "fields": {"day": "24Hr Unit Rate", "ev": "EV 2am - 6am", "standing": "Urban Standing Charge"}}
    assert vs.read_recipe(src, PAGES) == {"values": {"day": 0.367, "ev": 0.1211, "standing": 334.19}}


def test_times_in_a_label_are_not_prices():
    src = {"url": PAGE["url"], "fields": {"day": {"label": "Day Unit Price", "col": 2}}}
    assert vs.read_recipe(src, PAGES)["values"]["day"] == 0.458


def test_a_renamed_label_is_unreadable_not_silently_kept():
    src = {"url": PAGE["url"], "fields": {"day": "Standard Unit Rate"}}
    assert "error" in vs.read_recipe(src, PAGES)


def test_flogas_api_prefers_the_price_in_force():
    body = {"value": [{"name": "Smart 24Hr", "pricing": [{"resource": "electricity", "tables": [{"rows": [
        {"label": "24 HR Unit Rate", "items": [{"incVATPrice": 24.91, "dates": [
            {"startDateTime": "2026-07-20T08:00:00Z", "incVATPrice": 29.31}]}]},
        {"label": "Standing Charge", "items": [{"dates": [{"startDateTime": "2026-07-20T08:00:00Z", "incVATPrice": 300.2}]}]},
        {"label": "Standing Charge", "items": [{"dates": [{"startDateTime": "2026-07-20T08:00:00Z", "incVATPrice": 366.1}]}]},
    ]}]}]}]}
    pages = {"x": {"url": "x", "json": [{"url": "https://webapi-prd.flogas.ie/pricing-plans/api/v1/plan", "body": json.dumps(body)}]}}
    src = {"api": "flogas", "plan": "Smart 24Hr", "fields": {"day": "24 hr unit rate", "standing": "standing charge"}}
    assert vs.read_recipe(src, pages) == {"values": {"day": 0.2931, "standing": 300.2}}


def test_flogas_rural_standing_is_the_rows_second_figure():
    # As Flogas's feed carries it from 7 Oct 2026: one row, urban then rural.
    body = {"value": [{"name": " Smart EV Night Charge Electricity 10% Discount", "pricing": [{"resource": "electricity", "tables": [{"rows": [
        {"label": "EV Night Charge - 02:00 to 05:00", "items": [{"dates": [{"startDateTime": "2026-03-23T00:00:00Z", "incVATPrice": 12.63}]}]},
        {"label": "Standing Charge", "items": [{"dates": [{"startDateTime": "2026-03-23T00:00:00Z", "incVATPrice": 387.16}]},
                                               {"dates": [{"startDateTime": "2026-03-23T00:00:00Z", "incVATPrice": 472.36}]}]},
    ]}]}]}]}
    pages = {"x": {"url": "x", "json": [{"url": "https://webapi-prd.flogas.ie/pricing-plans/api/v1/plan", "body": json.dumps(body)}]}}
    src = {"api": "flogas", "plan": "Smart EV Night Charge Electricity 10% Discount",
           "fields": {"ev": "ev night charge - 02:00", "standing": "standing charge", "standing_rural": {"label": "standing charge", "item": 2}}}
    assert vs.read_recipe(src, pages) == {"values": {"ev": 0.1263, "standing": 387.16, "standing_rural": 472.36}}


CARDS = {"url": "https://example.ie/plans", "html": 'x"1 Year Electricity 30% plus €125 Welcome credit"y', "text": "\n".join([
    "Saver 16%", "16%", "More information", "€30 Welcome Bonus", "Smart Meter",
    "Green Electricity", "5.5%", "More information", "Standard meter",
])}
CPAGES = {vs.norm_url(CARDS["url"]): CARDS}


def test_welcome_credit_is_read_from_its_own_card():
    assert vs.read_welcome({"url": CARDS["url"], "anchor": ["Saver 16%"]}, CPAGES) == {"value": 30.0}


def test_a_card_without_a_credit_reads_zero_not_the_next_cards():
    assert vs.read_welcome({"url": CARDS["url"], "anchor": ["Green Electricity"]}, CPAGES) == {"value": 0.0}


def test_a_credit_drawn_by_script_is_read_from_the_page_code():
    rec = {"url": CARDS["url"], "anchor": ["1 Year Electricity 30% plus"], "in": "html", "chars": 40}
    assert vs.read_welcome(rec, CPAGES) == {"value": 125.0}


def test_an_uncaptured_page_is_unreadable():
    assert "error" in vs.read_welcome({"url": "https://example.ie/gone", "anchor": []}, CPAGES)


# A tariffs page as Energia prints it: today's standing charges under each
# plan, and a table of the prices that start on the 12th.
TARIFFS = {"url": "https://example.ie/tariffs", "text": "\n".join([
    "Standard Rate c/kWh as of 12th Oct 2026 (Ex VAT)",
    "Smart Data", "Day", "Electricity", "39.81", "Night", "Electricity", "27.20",
    "Annual Standing Charge", "As of 12th Oct 2026 (Ex VAT)",
    "Smart Data (Urban)", "Electricity", "€255.29", "Smart Data (Rural)", "Electricity", "€324.65",
    "Smart Meter Tariff Rates", "Electricity Standard Smart Data",
    "Standing charge MCC12 urban per year", "€ 265.01", "Standing charge MCC12 rural per year", "€ 337.02",
])}
# A tariffs page that draws its tables from data in the page, as Bord Gáis's does.
ROWS = {"url": "https://example.ie/our-tariffs", "text": "", "html": "<script>var t=[" + ",".join([
    '{"Product":"Smart","Price Plan":"Urban Smart All Day","Rate Type":"Day Rate","Annual Standing Charge (Inc VAT)":"262.38"}',
    '{"Product":"Smart","Price Plan":"Rural Smart All Day ","Rate Type":"Day Rate","Annual Standing Charge (Inc VAT)":"329.42"}',
]) + "]</script>"}
MORE = {**PAGES, vs.norm_url(TARIFFS["url"]): TARIFFS, vs.norm_url(ROWS["url"]): ROWS}
PLAN = {"id": "X", "rates": {"day": 0.3075, "night": 0.1691}, "standing": 265.01, "standing_rural": 337.02,
        "price_change": {"effective_date": "2026-10-12", "pct": 0.03, "pct_bands": {"night": 0.28}, "standing_pct": 0.05}}


def test_standing_charges_are_read_from_their_own_page():
    src = {"url": TARIFFS["url"], "anchor": ["Smart Meter Tariff Rates", "Electricity Standard Smart Data"],
           "fields": {"standing": "Standing charge MCC12 urban per year", "standing_rural": "Standing charge MCC12 rural per year"}}
    assert vs.read_recipe(src, MORE) == {"values": {"standing": 265.01, "standing_rural": 337.02}}


def test_a_row_the_page_carries_as_data_is_read_by_its_columns():
    src = {"url": ROWS["url"], "in": "rows", "match": {"Price Plan": "Rural Smart All Day", "Rate Type": "Day Rate"},
           "fields": {"standing_rural": "Annual Standing Charge (Inc VAT)"}}
    assert vs.read_recipe(src, MORE) == {"values": {"standing_rural": 329.42}}
    gone = {**src, "match": {"Price Plan": "Rural Smart EV"}}
    assert "error" in vs.read_recipe(gone, MORE)


FUTURE = [
    {"url": TARIFFS["url"], "from": "2026-10-12", "anchor": ["Standard Rate c/kWh as of 12th Oct 2026", "Smart Data"],
     "fields": {"day": "Day", "night": "Night"}, "vat": 1.09, "discount": 0.27},
    {"url": TARIFFS["url"], "from": "2026-10-12", "anchor": ["Standard Rate c/kWh as of 12th Oct 2026", "Annual Standing Charge"],
     "vat": 1.09, "fields": {"standing": "Smart Data (Urban)", "standing_rural": "Smart Data (Rural)"}},
]


def test_announced_prices_that_match_the_recorded_change_pass():
    assert vs.check_future(PLAN, FUTURE, MORE, "2026-10-09") == []


def test_an_announced_rise_recorded_wrong_is_reported():
    wrong = {**PLAN, "price_change": {**PLAN["price_change"], "standing_pct": 0.28}}
    rows = vs.check_future(wrong, FUTURE, MORE, "2026-10-09")
    assert len(rows) == 2 and all("ANNOUNCED DIFFERS" in r and "standing" in r for r in rows)


def test_an_announced_rise_not_recorded_at_all_says_so():
    rows = vs.check_future({**PLAN, "price_change": None}, FUTURE, MORE, "2026-10-09")
    assert rows and all("no change recorded for that date" in r for r in rows)


def test_once_the_date_comes_the_ordinary_check_takes_over():
    assert vs.check_future({**PLAN, "price_change": None}, FUTURE, MORE, "2026-10-12") == []


# Ecopower prints whole-cent prices bare ("44"), each with its unit on the line
# under it, first excluding VAT, then including it (12 Oct 2026).
ECO = {"url": "https://ecopower.ie/price-plan-26/", "text": "\n".join([
    "Urban – SST Smart Meter – Domestic", "10% Discount Price Plan", "100% Green Electricity",
    "Excluding VAT", "Including VAT", "1. Unit rates", "cent/kwh", "10% Discount Rate", "Standard Rate",
    "Urban Smart Meter Day (8am-11pm)", "37.5", "cents/kWh", "41.7", "cents/kWh",
    "Urban Smart Meter Peak (5pm-7pm)", "44", "cents/kWh", "48.9", "cents/kWh",
    "2. Standing Charges", "(Excluding VAT)", "Per Day", "Per Year",
    "Urban Smart Meter", "76", "cents/day", "277.4", "euro/year", "3. PSO Levy",
    "1. Unit rates", "Urban Smart Meter Day (8am-11pm)", "40.9", "cents/kWh", "45.5", "cents/kWh",
    "2. Standing Charges", "(Including VAT)", "Per Day", "Per Year",
    "Urban Smart Meter", "82.8", "cents/day", "302.37", "euro/year", "3. PSO Levy",
])}
EPAGES = {vs.norm_url(ECO["url"]): ECO}


def test_whole_cent_prices_are_read_when_the_recipe_says_so():
    src = {"url": ECO["url"], "anchor": ["SST Smart Meter", "1. Unit rates"], "whole": True, "vat": 1.09,
           "fields": {"day": "Urban Smart Meter Day", "peak": "Urban Smart Meter Peak"}}
    assert vs.read_recipe(src, EPAGES) == {"values": {"day": 0.4088, "peak": 0.4796}}


def test_without_it_a_bare_44_is_never_taken_as_the_price():
    src = {"url": ECO["url"], "anchor": ["SST Smart Meter", "1. Unit rates"], "vat": 1.09,
           "fields": {"peak": "Urban Smart Meter Peak"}}
    assert vs.read_recipe(src, EPAGES).get("values", {}).get("peak") != 0.4796


def test_a_unit_under_a_figure_keeps_the_row_going_to_the_yearly_figure():
    src = {"url": ECO["url"], "anchor": ["SST Smart Meter", "(Including VAT)"], "whole": True,
           "fields": {"standing": {"label": "Urban Smart Meter", "col": 2}}}
    assert vs.read_recipe(src, EPAGES) == {"values": {"standing": 302.37}}


def test_a_plan_unread_for_a_week_says_so_and_the_note_goes_once_it_reads():
    plan = {"id": "SSE-EVDAY", "verified_date": "2026-10-13", "notes": "Smart plan."}
    assert not vs.mark_unread(dict(plan), "2026-10-19")   # six days: not yet
    assert vs.mark_unread(plan, "2026-10-20")
    assert plan["notes"] == "Smart plan. UNVERIFIED since 2026-10-13: the daily check could not read the supplier's page."
    assert not vs.mark_unread(plan, "2026-10-21")         # said once
    vs.clear_unread(plan)
    assert plan["notes"] == "Smart plan."


def test_a_note_a_person_wrote_stays_when_the_plan_reads_again():
    plan = {"notes": "UNVERIFIED from 1 Oct 2026: no later list is published yet."}
    vs.clear_unread(plan)
    assert plan["notes"] == "UNVERIFIED from 1 Oct 2026: no later list is published yet."


def test_one_unreadable_plan_is_marked_and_the_others_still_update(tmp_path, monkeypatch):
    # 21 Oct 2026: one relabelled standing charge held back every supplier's prices.
    plans = [
        {"id": "READS", "supplier": "A", "rates": {"day": 0.30}, "verified_date": "2026-10-13",
         "source": {"url": PAGE["url"], "anchor": ["EV Plan", "24hr Urban"], "col": 2, "fields": {"day": "24Hr Unit Rate"}}},
        {"id": "RENAMED", "supplier": "A", "rates": {"day": 0.30}, "verified_date": "2026-10-13", "notes": "",
         "source": {"url": PAGE["url"], "fields": {"day": "Standard Unit Rate"}}},
    ]
    tariffs = tmp_path / "tariffs.json"
    tariffs.write_text(json.dumps(plans))
    monkeypatch.setattr(vs, "TARIFFS", tariffs)
    monkeypatch.setattr(vs, "ROOT", tmp_path)
    monkeypatch.setattr(vs, "load_evidence", lambda folder: PAGES)
    monkeypatch.setattr(vs, "write_embedded", lambda t: None)
    monkeypatch.setattr(vs, "fill_unused_bands", lambda t: None)
    monkeypatch.setattr(vs, "coverage", lambda t, p: [])

    class Day(vs.date):
        @classmethod
        def today(cls):
            return cls(2026, 10, 21)
    monkeypatch.setattr(vs, "date", Day)
    vs.main(["verify", str(tmp_path), "--apply"])
    out = {p["id"]: p for p in json.loads(tariffs.read_text())}
    assert out["READS"]["rates"]["day"] == 0.367 and out["READS"]["verified_date"] == "2026-10-21"
    assert out["RENAMED"]["verified_date"] == "2026-10-13"
    assert "UNVERIFIED since 2026-10-13" in out["RENAMED"]["notes"]
    assert "(marked unverified)" in (tmp_path / "verify_report.md").read_text()
