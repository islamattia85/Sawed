#!/usr/bin/env python3
"""
Tests for the finding and parsing layer.

The previous scraper had no tests at all, and the only thing exercising it was
the live daily run — which is how it managed to fail for eight weeks while
reporting success. Everything here runs against fixture strings, so a parser
regression is caught in CI on the commit that causes it, not eight weeks later
by a user reading a stale rate.

Nothing here touches the network. Discovery and fetching against real supplier
sites cannot be tested from CI in any meaningful way; what can be tested is that
given a page, we find the right link, and given a link, we read the right number.
"""

import pytest

import sources
from sources import (
    Fetched, candidate_links, embedded_json, rates_from_json, rates_from_text,
    standing_from_text, walk, _as_cents,
)
from scrape_tariffs import attribute, unknown_suppliers


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

HOMEPAGE = """
<html><body>
  <nav>
    <a href="/">Home</a>
    <a href="/home/electricity/our-plans">Our Plans</a>
    <a href="/about-us">About us</a>
    <a href="/business/electricity/tariffs">Business tariffs</a>
    <a href="/news/we-won-an-award">News</a>
    <a href="/docs/standard-price-list.pdf">Standard price list (PDF)</a>
    <a href="https://twitter.com/supplier">Follow us</a>
    <a href="#main">Skip to content</a>
  </nav>
</body></html>
"""


def test_discovery_finds_the_price_pages_and_skips_the_furniture():
    found = candidate_links(HOMEPAGE, "https://www.example.ie/")
    assert "https://www.example.ie/docs/standard-price-list.pdf" in found
    assert "https://www.example.ie/home/electricity/our-plans" in found
    assert not any("about-us" in u or "news" in u or "twitter" in u for u in found)


def test_business_pages_are_rejected():
    # A business tariff page matches every price keyword and would quietly
    # poison residential rates if it ranked.
    found = candidate_links(HOMEPAGE, "https://www.example.ie/")
    assert not any("/business/" in u for u in found)


def test_the_price_list_pdf_outranks_the_marketing_page():
    # The regulator-facing document changes shape least often, so it is worth
    # reading first when both are available.
    found = candidate_links(HOMEPAGE, "https://www.example.ie/")
    assert found[0].endswith(".pdf")


def test_offsite_links_are_dropped():
    html = '<a href="https://bonkers.ie/electricity-prices">Compare prices</a>'
    assert candidate_links(html, "https://www.example.ie/") == []


# ---------------------------------------------------------------------------
# Failure classification
#
# The distinction this whole rewrite turns on: a 404 is a broken link somebody
# has to fix, a 403 is a refusal, and they must never again read the same in a
# log.
# ---------------------------------------------------------------------------

def test_failure_kinds_stay_distinct():
    assert Fetched("u", kind="moved").ok is False
    assert Fetched("u", kind="ok").ok is True
    assert Fetched("u", kind="moved").kind != Fetched("u", kind="refused").kind


# ---------------------------------------------------------------------------
# Structured data
# ---------------------------------------------------------------------------

NEXT_PAGE = """
<html><body><h1>Plans</h1>
<script id="__NEXT_DATA__" type="application/json">
{"props":{"pageProps":{"tariffs":[
  {"name":"Smart Standard","unitRate":0.3421,"standingCharge":289.55},
  {"name":"EV Night","unitRate":"9.87c"}
]}}}
</script>
</body></html>
"""


def test_rates_are_read_from_embedded_json():
    blobs = embedded_json(NEXT_PAGE)
    assert blobs, "__NEXT_DATA__ was not picked up"
    rates = rates_from_json(blobs)
    assert 0.3421 in rates.values()
    assert 0.0987 in rates.values()


def test_ld_json_is_read_too():
    html = ('<script type="application/ld+json">'
            '{"@type":"Offer","priceSpecification":{"unitRate":"32.10 cent"}}</script>')
    assert 0.321 in rates_from_json(embedded_json(html)).values()


def test_malformed_json_does_not_stop_the_page():
    html = '<script type="application/ld+json">{not json at all</script><p>28.4c</p>'
    assert embedded_json(html) == []
    assert rates_from_text("28.4c per kWh") == [0.284]


def test_euro_and_cent_notation_both_land_on_cents():
    assert _as_cents(0.3245) == pytest.approx(32.45)
    assert _as_cents(32.45) == pytest.approx(32.45)
    assert _as_cents("32.45c") == pytest.approx(32.45)


def test_numbers_that_cannot_be_a_rate_are_rejected():
    # An out-of-range value is far more likely to be a phone number, a year or a
    # kWh allowance than a tariff, and a wrong rate that reaches a
    # recommendation is worse than a missing one.
    assert _as_cents(2024) is None
    assert _as_cents(0.001) is None
    assert _as_cents("hello") is None
    assert _as_cents(None) is None


def test_walk_reaches_nested_leaves():
    paths = dict(walk({"a": [{"b": 1}]}))
    assert paths["a[0].b"] == 1


# ---------------------------------------------------------------------------
# Prose fallback
# ---------------------------------------------------------------------------

def test_rates_and_standing_charges_are_read_from_prose():
    text = "Day rate 34.21 cent per kWh. Standing charge €289.55 per year."
    assert rates_from_text(text) == [0.3421]
    assert standing_from_text(text) == [289.55]


def test_a_price_in_euro_is_not_mistaken_for_a_unit_rate():
    assert rates_from_text("Your bill was €245.00") == []


# ---------------------------------------------------------------------------
# Attribution — which plan a number belongs to
# ---------------------------------------------------------------------------

PLANS = {"X-24": ["all day", "flat rate"], "X-DNP": ["day night peak"]}
EXISTING = {"X-24": {}, "X-DNP": {}}


def test_a_rate_is_attributed_to_the_plan_it_sits_beside():
    text = ("Smart All Day 33.10 cent per kWh, standing charge €279.00. "
            "Day Night Peak 30.50 cent per kWh.")
    got = attribute(text, PLANS, EXISTING)
    assert got["X-24"]["_scraped_day_rate"] == 0.331
    assert got["X-DNP"]["_scraped_day_rate"] == 0.305


def test_a_withdrawn_plan_is_marked_rather_than_repriced():
    got = attribute("Day Night Peak is no longer available to new customers.",
                    PLANS, EXISTING)
    assert got["X-DNP"]["discontinued"] is True
    assert "_scraped_day_rate" not in got["X-DNP"]


def test_plans_we_do_not_carry_are_ignored():
    assert attribute("All Day 33.10c", PLANS, {"X-DNP": {}}) == {}


# ---------------------------------------------------------------------------
# Comparison-site cross-check
# ---------------------------------------------------------------------------

def test_an_unknown_supplier_is_flagged_and_page_furniture_is_not():
    text = ("Compare Energy plans from Electric Ireland, Bord Gáis Energy and "
            "Kilkenny Power. Learn More Energy about switching today.")
    got = unknown_suppliers(text)
    assert "Kilkenny Power" in got
    assert not any("Learn" in n or "Compare" in n for n in got)
    assert not any("Bord" in n for n in got)

# ---------------------------------------------------------------------------
# Tolerances — what the 28 July run tried to write
# ---------------------------------------------------------------------------

from scrape_tariffs import apply_updates


def _plan(pid, day, standing):
    return {"id": pid, "type": "flat", "standing": standing,
            "rates": {"day": day, "night": day, "peak": day, "ev": day}}


def test_a_standing_charge_jumping_a_quarter_is_rejected():
    # Proposed on 28 July: €331.96 -> €250.00, a 25% fall, accepted by the old
    # absolute-only guard of ±€100. A change that size is a supplier
    # announcement, not something to take from a regex unreviewed.
    plans = [_plan("BG-DYN", 0.30, 331.96)]
    out, _ = apply_updates(plans, {"BG-DYN": {"_scraped_standing": 250.0}})
    assert out[0]["standing"] == 331.96


def test_a_unit_rate_jumping_a_tenth_is_rejected():
    # Proposed on 28 July: 33.25c -> 36.40c on EI-NB, +9.5%. Inside the old ±5c
    # absolute tolerance (±15% on a 33c rate) and inside a 10% relative one too,
    # which is why the threshold is 5%.
    plans = [_plan("EI-NB", 0.3325, 300.0)]
    out, _ = apply_updates(plans, {"EI-NB": {"_scraped_day_rate": 0.3640}})
    assert out[0]["rates"]["day"] == 0.3325


def test_a_small_correction_is_still_accepted():
    # The guard has to leave room for real movement, or it is just an off switch.
    plans = [_plan("EI-24", 0.3114, 300.0)]
    out, changes = apply_updates(plans, {"EI-24": {"_scraped_day_rate": 0.3055}})
    assert out[0]["rates"]["day"] == 0.3055
    assert changes == 1


def test_a_flat_plan_updates_every_band_together():
    plans = [_plan("EI-24", 0.3114, 300.0)]
    out, _ = apply_updates(plans, {"EI-24": {"_scraped_day_rate": 0.3055}})
    assert set(out[0]["rates"].values()) == {0.3055}


def test_reaching_a_site_but_finding_no_prices_is_not_a_broken_link():
    # Reported yunoenergy.ie and pinergy.ie as broken links on 28 July. Both
    # homepages were fine; discovery simply recognised nothing on them. Sending
    # someone to hunt a 404 that does not exist wastes the one signal the report
    # is for.
    assert Fetched("u", kind="nolinks").kind != Fetched("u", kind="moved").kind
    assert Fetched("u", kind="nolinks").ok is False


# ---------------------------------------------------------------------------
# Seeded discovery
#
# These exist because of the 25 August 2026 run. All seven supplier homepages
# answered 200 and produced zero candidate links, so the scraper reported seven
# `nolinks` and verified nothing, for a month, while the app went on presenting
# June rates as current. The cause was not blocking and not rot: the suppliers
# render their navigation with script, and there are no anchors in the HTML a
# static parse can see.
# ---------------------------------------------------------------------------

class _StubSession:
    """A session that answers every request with an empty JavaScript shell."""

    SHELL = "<html><head></head><body><div id='app'></div></body></html>"

    def __init__(self):
        self.requested = []

    def get(self, url, **kwargs):
        self.requested.append(url)

        class R:
            status_code = 200
            text = _StubSession.SHELL
            content = _StubSession.SHELL.encode()
            url = ""
        return R()


def test_seeds_survive_a_homepage_with_no_links_in_it():
    """The exact failure: a script-rendered shell yields nothing to rank."""
    session = _StubSession()
    assert sources.candidate_links(_StubSession.SHELL, "https://example.ie/") == []

    pages = sources.discover(
        "https://example.ie/",
        session=session,
        seeds=["/home/our-tariffs", "/home/ev-plan-comparison"],
    )
    assert pages == [
        "https://example.ie/home/our-tariffs",
        "https://example.ie/home/ev-plan-comparison",
    ]


def test_seeds_are_tried_before_discovery_but_do_not_replace_it():
    """
    A seed is a head start, not a substitute. If discovery ever finds the page
    again, it must still be in the list — otherwise a seed that quietly rots
    takes the whole supplier down with it.
    """
    html = """
      <html><body>
        <a href="/home/price-plans">Our price plans</a>
        <a href="/business/prices">Business prices</a>
      </body></html>
    """

    class Session(_StubSession):
        def get(self, url, **kwargs):
            r = super().get(url, **kwargs)
            if url.rstrip("/") == "https://example.ie":
                r.text = html
                r.content = html.encode()
            return r

    pages = sources.discover(
        "https://example.ie/", session=Session(), seeds=["/home/our-tariffs"]
    )
    assert pages[0] == "https://example.ie/home/our-tariffs"
    assert "https://example.ie/home/price-plans" in pages
    assert not any("business" in p for p in pages)


def test_a_seed_is_not_duplicated_when_discovery_finds_it_too():
    html = '<html><body><a href="/home/our-tariffs">Our tariffs</a></body></html>'

    class Session(_StubSession):
        def get(self, url, **kwargs):
            r = super().get(url, **kwargs)
            if url.rstrip("/") == "https://example.ie":
                r.text = html
                r.content = html.encode()
            return r

    pages = sources.discover(
        "https://example.ie/", session=Session(), seeds=["/home/our-tariffs"]
    )
    assert pages.count("https://example.ie/home/our-tariffs") == 1


def test_price_words_recognise_the_paths_suppliers_actually_use():
    for path in (
        "/home/ev-plan-comparison",
        "/about-energia/our-tariffs",
        "/residential/products/smart-meters/plans",
        "/home/compare-electricity-price-plans",
    ):
        assert sources.PRICE_WORDS.search(path), path
