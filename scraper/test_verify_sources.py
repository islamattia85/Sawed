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
