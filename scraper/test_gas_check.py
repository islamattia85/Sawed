"""The gas parsers, against the suppliers' pages as captured on 4 Oct 2026."""
from pathlib import Path

import gas_check as G

FX = Path(__file__).parent / "fixtures" / "gas"


def page(name):
    return (FX / f"{name}.txt").read_text(encoding="utf-8").splitlines()


def test_bord_gais_current_upcoming_and_dual():
    p = G.PAGES["Bord Gáis Energy"]
    got = G.parse_bord_gais({p[0]: page("bg_tariffs"), p[1]: page("bg_dual"),
                             p[2]: ["Get 9% off gas"]})
    assert got["unit"] == 0.1117 and got["standing"] == 131.69
    assert got["dual_discount"] == 0.17 and got["gas_discount"] == 0.09
    pc = got["price_change"]
    assert pc["effective_date"] == "2026-10-09"
    assert abs(pc["pct"] - (12.36 / 11.17 - 1)) < 1e-4
    assert abs(pc["standing_pct"] - (140.92 / 131.69 - 1)) < 1e-4


def test_electric_ireland_standard_rate_and_standing_from_eab():
    p = G.PAGES["Electric Ireland"]
    got = G.parse_electric_ireland({p[0]: page("ei_gas"), p[1]: page("ei_dual")})
    assert got["gas_discount"] == 0.10 and got["dual_discount"] == 0.16
    assert abs(got["unit"] - 0.11016 / 0.9) < 1e-5
    assert 140 < got["standing"] < 160


def test_energia_rates_are_ex_vat_on_the_page():
    p = G.PAGES["Energia"]
    got = G.parse_energia({p[0]: page("energia_tariffs"), p[1]: ["10% Discount on our standard gas rate"]})
    assert abs(got["unit"] - 0.1152 * 1.09) < 1e-5
    assert got["standing"] == round(129.91 * 1.09, 2)
    assert got["gas_discount"] == 0.10


def test_sse_standard_rate_and_standing():
    got = G.parse_sse({G.PAGES["SSE Airtricity"][0]: page("sse_gas")})
    assert got == {"unit": 0.1138, "gas_discount": 0.16, "standing": 152.31}


def test_flogas_dual_plan():
    got = G.parse_flogas({G.PAGES["Flogas"][0]: page("flogas")})
    assert got["dual_discount"] == 0.28 and got["standing"] == 170.84
    assert abs(got["unit"] - 0.0914 / 0.72) < 1e-5


def test_a_redesigned_page_reads_as_nothing_and_is_reported():
    assert G.parse_sse({G.PAGES["SSE Airtricity"][0]: ["New design", "Call us"]}) == {}
    cur = [{"supplier": "SSE Airtricity", "unit": 0.1138, "standing": 152.31, "verified_date": "2026-10-04"}]
    new, lines, clean = G.compare(cur, {"SSE Airtricity": {}})
    assert not clean and "UNREADABLE" in lines[0] and new == cur


def test_compare_updates_only_what_changed():
    cur = [{"supplier": "Flogas", "unit": 0.1269, "standing": 170.84, "dual_discount": 0.28, "verified_date": "2026-10-04"}]
    new, lines, clean = G.compare(cur, {"Flogas": {"unit": 0.13, "standing": 170.84, "dual_discount": 0.28}})
    assert clean and new[0]["unit"] == 0.13 and "unit 0.1269 → 0.13" in lines[0]
    new, lines, clean = G.compare(cur, {"Flogas": {"unit": 0.12692, "standing": 170.84, "dual_discount": 0.28}})
    assert new[0]["unit"] == 0.1269 and "unchanged" in lines[0]


def test_the_stored_data_matches_what_the_pages_said():
    import json
    data = {g["supplier"]: g for g in json.loads(G.DATA.read_text(encoding="utf-8"))}
    p = G.PAGES["Bord Gáis Energy"]
    bg = G.parse_bord_gais({p[0]: page("bg_tariffs"), p[1]: page("bg_dual"), p[2]: ["Get 9% off gas"]})
    assert abs(bg["unit"] - data["Bord Gáis Energy"]["unit"]) < 1e-5
