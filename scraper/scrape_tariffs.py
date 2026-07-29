#!/usr/bin/env python3
"""
Irish electricity tariff scraper.

Finds each supplier's price page, reads the rates, and updates tariffs.json.
Runs daily via GitHub Actions. Only updates fields it can confidently extract;
falls back to existing data on failure, and fails the run loudly rather than
writing a fresh timestamp over stale numbers.

Why this looks nothing like the previous version
------------------------------------------------
The 26 July run made twelve failed requests. Eleven were HTTP 404 and one was a
TLS chain error. Not one was a 403, a rate limit or a bot challenge — the
suppliers were never blocking us. The URLs were hardcoded deep links and the
sites had been reorganised underneath them, and because every failure was logged
as the same shrug of a warning, "the page moved" was indistinguishable from
"they refused us". The app went as far as telling users their rates were
current because supplier sites block scrapers, which was false.

So the shape changed:

  * pages are discovered from the supplier's homepage and sitemap, not pinned;
  * structured data (__NEXT_DATA__, JSON-LD, __NUXT__) is read before prose,
    and the regulator-facing price-list PDF before either;
  * every failure keeps its own name, and 404 is reported as a broken link that
    somebody has to fix rather than a fact of life.

The finding and parsing live in sources.py as pure functions over bytes, so they
can be tested against fixtures. This file is the orchestration around them.
"""

import json
import re
import sys
import logging
from datetime import date
from pathlib import Path

import requests
from bs4 import BeautifulSoup

from sources import (
    Fetched, SupplierResult, fetch, discover, embedded_json,
    rates_from_json, rates_from_text, standing_from_text, pdf_text,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger(__name__)

TARIFFS_PATH = Path(__file__).parent.parent / "public" / "tariffs.json"
MIN_COVERAGE = 0.60   # fail the run below this share of plans re-verified
TODAY = date.today().isoformat()

#: How many discovered pages to read per supplier before giving up. Discovery is
#: ranked, so the price page is normally first or second; the tail is there for
#: sites that bury it a level down.
MAX_PAGES = 4


# ---------------------------------------------------------------------------
# Who we scrape
#
# A root and a set of plan keywords, nothing more. No deep links: that is the
# bug this rewrite exists to remove. Keywords match plan names as the supplier
# writes them, and are used to attribute a rate to one of our plan ids.
# ---------------------------------------------------------------------------

SUPPLIERS = [
    {
        "name": "Electric Ireland",
        "root": "https://www.electricireland.ie/",
        "plans": {
            "EI-24":  ["24hr", "24 hr", "home dual+ 24", "flat rate"],
            "EI-SST": ["smart standard", "day night peak", "time of use", "sst"],
            "EI-NB":  ["night boost"],
            "EI-DYN": ["dynamic"],
        },
    },
    {
        "name": "Bord Gáis Energy",
        "root": "https://www.bordgaisenergy.ie/",
        "plans": {
            "BG-24":  ["all day", "smart all day", "flat rate"],
            "BG-TOU": ["smart standard", "day night peak"],
            "BG-EV":  ["ev smart", "ev plan"],
            "BG-DYN": ["dynamic", "smart dynamic"],
        },
    },
    {
        "name": "SSE Airtricity",
        "root": "https://www.sseairtricity.com/ie/home/",
        "plans": {
            "SSE-EVDAY": ["24hr smart", "24 hour smart", "flat"],
            "SSE-DNP":   ["day night peak", "day/night/peak", "smart dnp"],
            "SSE-EVMAX": ["ev max", "evmax"],
        },
    },
    {
        "name": "Energia",
        "root": "https://www.energia.ie/",
        "plans": {
            "EN-24":      ["standard", "24hr", "flat"],
            "EN-SMART":   ["smart data", "day night peak", "time of use"],
            "EN-EV":      ["ev smart drive", "ev drive"],
            "EN-EV-PLUS": ["ev smart drive plus", "ev drive plus"],
            "EN-DYN":     ["dynamic"],
        },
    },
    {
        "name": "Yuno Energy",
        "root": "https://www.yunoenergy.ie/",
        "plans": {
            "YN-24":  ["standard smart", "flat", "24hr"],
            "YN-DNP": ["day night peak", "dnp", "smart day"],
            "YN-EV":  ["ev variable"],
        },
    },
    {
        "name": "Flogas",
        "root": "https://www.flogas.ie/",
        "plans": {
            "FL-24":  ["smart 24", "flat", "24 hour"],
            "FL-DNP": ["day night peak", "smart dnp", "day night"],
        },
    },
    {
        "name": "Pinergy",
        "root": "https://www.pinergy.ie/",
        "plans": {
            "PIN-LF":  ["lifestyle standard", "standard smart"],
            "PIN-WFH": ["working from home", "wfh"],
            "PIN-FAM": ["family time", "family"],
            "PIN-EV":  ["ev night"],
        },
    },
]


# ---------------------------------------------------------------------------
# Reading one supplier
# ---------------------------------------------------------------------------

def attribute(text: str, plans: dict, existing: dict) -> dict:
    """
    Match rates in a page's text to our plan ids by plan name.

    Same idea as the old parsers — find the plan name, read the numbers near it
    — but it is now the last resort rather than the only method, and it runs
    over whatever page discovery found rather than one URL frozen in 2024.

    The window runs forward from the plan name and stops at the next plan name.
    The old version read 200 characters behind as well, which on a page listing
    plans one after another reached back into the previous plan and copied its
    rate — every plan on the page ending up priced as the first one, with no
    sign in the log that anything was wrong.
    """
    updates: dict = {}
    low = text.lower()
    all_keywords = [k for ks in plans.values() for k in ks]

    for plan_id, keywords in plans.items():
        if plan_id not in existing:
            continue
        for kw in keywords:
            idx = low.find(kw)
            if idx == -1:
                continue
            start = idx + len(kw)
            stop = min([low.find(other, start) for other in all_keywords
                        if low.find(other, start) != -1] + [start + 400])
            chunk = text[idx:stop]

            if re.search(r"no longer (available|on sale)|discontinued|withdrawn",
                         chunk, re.I):
                updates[plan_id] = {"discontinued": True,
                                    "discontinued_date": TODAY,
                                    "verified_date": TODAY}
                log.info(f"  {plan_id}: marked discontinued")
                break

            rates = rates_from_text(chunk)
            standing = standing_from_text(chunk)
            if not rates and not standing:
                continue
            upd = {"verified_date": TODAY}
            if rates:
                upd["_scraped_day_rate"] = rates[0]
            if standing:
                upd["_scraped_standing"] = standing[0]
            updates[plan_id] = upd
            log.info(f"  {plan_id}: rate={upd.get('_scraped_day_rate')} "
                     f"standing={upd.get('_scraped_standing')}")
            break
    return updates


def read_page(got: Fetched) -> tuple[str, dict]:
    """
    Everything readable on one fetched page: (plain text, structured candidates).

    A PDF yields text only. HTML yields both, and the structured half is worth
    far more — a value at
    props.pageProps.tariffs[0].unitRate is unambiguous, where a number three
    hundred characters from the words "Smart Standard" is a guess.
    """
    if got.url.lower().endswith(".pdf") or got.content[:5] == b"%PDF-":
        return pdf_text(got.content), {}

    soup = BeautifulSoup(got.text, "lxml")
    text = soup.get_text(" ", strip=True)
    structured = rates_from_json(embedded_json(got.text))
    return text, structured


def scrape_supplier(spec: dict, existing: dict,
                    session: requests.Session | None = None) -> tuple[dict, SupplierResult]:
    """Read one supplier, returning plan updates and a record of what happened."""
    name = spec["name"]
    result = SupplierResult(supplier=name)
    updates: dict = {}

    log.info(f"{name}: discovering price pages under {spec['root']}")
    pages, discovery_failures = discover(spec["root"], session=session)
    # Discovery used to swallow these. A homepage that will not load is a
    # completely different problem from a homepage with no price links on it,
    # and reporting the first as the second cost four weeks on Yuno, whose site
    # simply serves an incomplete certificate chain.
    result.failures.extend(discovery_failures)
    for f in discovery_failures:
        log.warning(f"  discovery: {f.url} → {f.kind}: {f.detail}")
    if not pages:
        log.warning(f"{name}: found no candidate price pages from the homepage or sitemap")

    for url in pages[:MAX_PAGES]:
        got = fetch(url, session=session)
        result.pages_tried.append(url)
        if not got.ok:
            result.failures.append(got)
            log.warning(f"  {url} → {got.kind}: {got.detail}")
            continue

        result.reached_a_page = True
        text, structured = read_page(got)
        if structured:
            result.rates.update(structured)
            log.info(f"  {url}: {len(structured)} structured rate candidate(s)")

        found = attribute(text, spec["plans"], existing)
        for plan_id, upd in found.items():
            updates.setdefault(plan_id, upd)
            if "_scraped_standing" in upd:
                result.standing.append(upd["_scraped_standing"])

        if len(updates) >= len(spec["plans"]):
            break

    if not result.reached_a_page and not result.failures:
        # Distinct from "moved". The site answered fine; discovery just found
        # nothing on it that looked like a price page. Filing that under broken
        # links reported two perfectly healthy homepages as dead URLs on the
        # 28 July run, which sends whoever reads it chasing a 404 that does not
        # exist instead of widening the discovery keywords.
        result.failures.append(
            Fetched(spec["root"], kind="nolinks",
                    detail="site reached, but no page on it looked like prices"))
    return updates, result


# ---------------------------------------------------------------------------
# Apply scraped updates to the tariff list
# ---------------------------------------------------------------------------

# A scraped value has to be close to the one it replaces, in RELATIVE terms.
#
# The absolute-only guards were far too loose to catch anything. ±5c on a 31c
# rate is ±16%; ±€100 on a €332 standing charge is ±30%. The 28 July run
# proposed moving a standing charge from €331.96 to exactly €250.00 and a unit
# rate up 3.15c — both sailed through. Irish tariffs do move, but a change of
# that size is a supplier announcement, not something to accept from a regex
# without a human looking at it.
RATE_TOLERANCE = 0.05        # absolute: never accept a jump bigger than 5c/kWh
RATE_TOLERANCE_REL = 0.05    # …and never more than 5% of the current rate
#
# 5% because a real Irish tariff move of that size is announced, and worth a
# person typing in. Below it, a difference is far more likely to be the parser
# than the supplier. The 28 July run proposed +9.5% on EI-NB, which sat inside
# a 10% threshold — so 10% would have let through the exact change that
# prompted writing this.
STANDING_TOLERANCE_REL = 0.15  # …and 15% for a standing charge

def apply_updates(tariffs: list, all_updates: dict) -> tuple[list, int]:
    """Merge scraped updates into tariffs. Returns (updated_list, change_count)."""
    by_id = {t["id"]: t for t in tariffs}
    changes = 0

    for plan_id, upd in all_updates.items():
        if plan_id not in by_id:
            log.warning(f"Unknown plan id {plan_id} — skipping")
            continue
        plan = by_id[plan_id]

        # Validate day rate against existing if available
        scraped_day = upd.pop("_scraped_day_rate", None)
        scraped_standing = upd.pop("_scraped_standing", None)

        if scraped_day is not None:
            existing_day = plan.get("rates", {}).get("day", 0)
            delta = abs(scraped_day - existing_day)
            rel = delta / existing_day if existing_day else 1.0
            if delta > RATE_TOLERANCE or rel > RATE_TOLERANCE_REL:
                log.warning(
                    f"{plan_id}: scraped day {scraped_day:.4f} vs existing {existing_day:.4f} "
                    f"— {delta:.4f} ({rel:.0%}) exceeds tolerance, skipping rate update. "
                    f"If the supplier really did change this, update it by hand."
                )
            else:
                # Flat plan: update all bands equally
                if plan.get("type") == "flat":
                    for band in plan["rates"]:
                        plan["rates"][band] = scraped_day
                else:
                    plan["rates"]["day"] = scraped_day
                log.info(f"{plan_id}: day rate updated to {scraped_day}")
                changes += 1

        if scraped_standing is not None:
            existing_standing = plan.get("standing", 0)
            sdelta = abs(scraped_standing - existing_standing)
            srel = sdelta / existing_standing if existing_standing else 1.0
            if srel > STANDING_TOLERANCE_REL:
                log.warning(
                    f"{plan_id}: scraped standing {scraped_standing} vs existing "
                    f"{existing_standing} — {sdelta:.2f} ({srel:.0%}) exceeds tolerance, skipping"
                )
            else:
                plan["standing"] = scraped_standing
                changes += 1

        # Apply remaining fields (discontinued, verified_date, etc.)
        for k, v in upd.items():
            plan[k] = v
            if k not in ("verified_date",):
                changes += 1

    return list(by_id.values()), changes


# ---------------------------------------------------------------------------
# Cross-check against the CRU's accredited comparison sites
#
# The regulator accredits a handful of price-comparison services, and they list
# every residential plan on the market in one place. That makes them a second
# opinion we get almost free: if a supplier's own site has gone quiet, their
# plans are still named here, and a plan we have never heard of shows up as a
# gap rather than as silence.
#
# We never auto-add or auto-price from these. They are third parties with their
# own refresh lag and their own commercial interests, and a wrong number that
# reaches a recommendation is far worse than a missing one. They raise flags for
# a human; nothing else.
# ---------------------------------------------------------------------------

COMPARISON_SITES = [
    ("CRU", "https://www.cru.ie/home/switching-supplier/electricity-and-gas-price-comparison/"),
    ("Bonkers.ie", "https://www.bonkers.ie/compare-gas-electricity-prices/"),
    ("Switcher.ie", "https://switcher.ie/gas-electricity/"),
]

KNOWN_SUPPLIERS = {
    "electric ireland", "bord gáis", "bord gais", "energia",
    "sse airtricity", "airtricity", "yuno", "flogas", "pinergy",
    "prepay power", "prepaypower", "community power", "waterpower",
}

#: Phrases that match the company-name pattern but are page furniture. The first
#: version of this reported "Learn More Compare Energy" as a supplier three
#: times over, which trains everyone to ignore the one channel meant to catch a
#: competitor launching.
NOISE = {
    "learn", "more", "compare", "fixed", "green", "smart", "home", "your",
    "the", "all", "our", "new", "best", "switch", "save", "find", "view",
    "read", "about", "renewable", "cheaper", "cheapest", "supplier", "cheap",
    "top", "latest", "today", "why", "how", "get", "see", "clean", "100",
}

SUPPLIER_RE = re.compile(
    r"\b([A-Z][a-zA-Z&]{2,}(?: [A-Z][a-zA-Z&]{2,}){0,2})\s+(?:Energy|Electricity|Power)\b")


def unknown_suppliers(text: str) -> set[str]:
    """Company names on a comparison page that are not in our tariff list."""
    out = set()
    for m in SUPPLIER_RE.finditer(text):
        raw = m.group(0).strip()
        if any(k in raw.lower() for k in KNOWN_SUPPLIERS):
            continue
        # Every leading word must look like a proper noun, not a verb or filler.
        lead = [w for w in m.group(1).split() if w]
        if not lead or any(w.lower() in NOISE for w in lead):
            continue
        out.add(raw)
    return out


def cross_check(missing_suppliers: set[str],
                session: requests.Session | None = None) -> list[str]:
    """
    Flags from the accredited comparison sites.

    Two kinds: a supplier we do not carry at all, and a supplier whose own site
    we failed to read today but whose plans are still listed here — which tells
    us the plans are alive and our parser is the thing that broke.
    """
    warnings: list[str] = []
    for label, url in COMPARISON_SITES:
        got = fetch(url, session=session)
        if not got.ok:
            log.warning(f"cross-check {label}: {got.kind} — {got.detail}")
            continue
        text = BeautifulSoup(got.text, "lxml").get_text(" ", strip=True)

        for name in sorted(unknown_suppliers(text)):
            warnings.append(f"{label} lists a supplier we do not carry: {name!r}")

        for name in sorted(missing_suppliers):
            head = name.split()[0].lower()
            if head and head in text.lower():
                warnings.append(
                    f"{name} is still listed on {label} but we could not read their "
                    f"own site today — the parser is what needs fixing, not the plan")
    return sorted(set(warnings))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if not TARIFFS_PATH.exists():
        log.error(f"tariffs.json not found at {TARIFFS_PATH}")
        sys.exit(1)

    with open(TARIFFS_PATH) as f:
        tariffs = json.load(f)

    existing = {t["id"]: t for t in tariffs}
    log.info(f"Loaded {len(tariffs)} plans from tariffs.json")

    session = requests.Session()
    all_updates: dict = {}
    results: list[SupplierResult] = []

    for spec in SUPPLIERS:
        try:
            updates, result = scrape_supplier(spec, existing, session=session)
            all_updates.update(updates)
            results.append(result)
            log.info(result.summary())
        except Exception as e:
            log.error(f"{spec['name']} crashed: {e}")
            results.append(SupplierResult(supplier=spec["name"]))

    updated_tariffs, n_changes = apply_updates(tariffs, all_updates)

    # Suppliers whose own site told us nothing today — the set the comparison
    # sites are most useful for.
    silent = {r.supplier for r in results if not r.rates and not r.reached_a_page}
    cru_warnings = cross_check(silent, session=session)
    for w in cru_warnings:
        log.warning(f"CROSS-CHECK: {w}")

    # A page that has moved is a broken link with an owner, not weather. It is
    # reported separately so it never again gets averaged in with real refusals.
    moved = [f for r in results for f in r.failures if f.kind == "moved"]
    tls = [f for r in results for f in r.failures if f.kind == "tls"]
    refused = [f for r in results for f in r.failures if f.kind == "refused"]
    nolinks = [f for r in results for f in r.failures if f.kind == "nolinks"]

    meta_idx = next((i for i, t in enumerate(updated_tariffs) if t.get("id") == "__meta__"), None)
    meta = {
        "id": "__meta__",
        "last_scraped": TODAY,
        "scraper_version": "2.0",
        "cru_warnings": cru_warnings,
        "suppliers": [r.summary() for r in results],
        "broken_links": [f.url for f in moved],
        "no_price_page_found": [f.url for f in nolinks],
        "tls_failures": [f.url for f in tls],
        "refused": [f.url for f in refused],
    }
    if meta_idx is not None:
        updated_tariffs[meta_idx] = meta
    else:
        updated_tariffs.insert(0, meta)

    with open(TARIFFS_PATH, "w") as f:
        json.dump(updated_tariffs, f, indent=2, ensure_ascii=False)

    log.info(f"Done. {n_changes} field(s) updated. tariffs.json written.")

    if cru_warnings:
        print("\n=== ACTION REQUIRED: comparison-site cross-check ===")
        for w in cru_warnings:
            print(f"  {w}")
        print()

    if moved:
        print("=== BROKEN LINKS (HTTP 404/410) ===")
        for f in moved:
            print(f"  {f.url}")
        print("These are not refusals. Somebody moved the page; discovery should\n"
              "have found the new one, so if this list is long the discovery\n"
              "keywords need widening.\n")
    if nolinks:
        print("=== REACHED, BUT NO PRICE PAGE FOUND ===")
        for f in nolinks:
            print(f"  {f.url}")
        print("Not broken links — these sites answered. Discovery could not\n"
              "recognise a price page on them, so PRICE_WORDS needs widening\n"
              "or the prices are behind a script-rendered nav.\n")
    if refused:
        print("=== ACTUALLY REFUSED (401/403/429) ===")
        for f in refused:
            print(f"  {f.url} — {f.detail}")
        print()
    if tls:
        print("=== TLS CHAIN FAILURES ===")
        for f in tls:
            print(f"  {f.url} — the server is serving an incomplete certificate chain")
        print()

    # ------------------------------------------------------------------
    # Fail loudly when the scrape did not actually verify anything.
    #
    # Every parser miss is a silent no-op, so a run where all seven suppliers
    # changed their markup used to finish green and write a last_scraped stamp
    # once described in this file as "proof the scraper ran". It proved only
    # that the job started. Meanwhile 25 of 26 plans went eight weeks unverified
    # while the dashboard stayed green and the app told users rates were
    # current. A scraper that silently matches nothing is worse than no scraper,
    # because it manufactures confidence.
    # ------------------------------------------------------------------
    verified_today = sum(
        1 for t in updated_tariffs
        if t.get("id") != "__meta__"
        and not t.get("discontinued")
        and t.get("verified_date") == TODAY
    )
    rankable = sum(
        1 for t in updated_tariffs
        if t.get("id") != "__meta__" and not t.get("discontinued")
    )
    coverage = verified_today / rankable if rankable else 0.0
    log.info(f"Coverage: {verified_today}/{rankable} plans verified today ({coverage:.0%})")

    if coverage < MIN_COVERAGE:
        log.error(
            f"Only {verified_today} of {rankable} plans were verified "
            f"({coverage:.0%}, floor is {MIN_COVERAGE:.0%}). Rates are going stale "
            f"silently. The per-supplier lines above say which half of the job "
            f"broke: 'NO PAGE REACHED' means discovery needs widening, "
            f"'nothing recognisable' means the parser does."
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
