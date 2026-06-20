#!/usr/bin/env python3
"""
Irish electricity tariff scraper.
Fetches rates from supplier websites/PDFs and updates tariffs.json.
Runs daily via GitHub Actions. Only updates fields it can confidently extract;
falls back to existing data on failure.
"""

import json
import re
import sys
import os
import logging
from datetime import date
from pathlib import Path
from typing import Optional

import requests
from bs4 import BeautifulSoup

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger(__name__)

TARIFFS_PATH = Path(__file__).parent.parent / "tariffs.json"
TODAY = date.today().isoformat()
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; SolarOptimiserBot/1.0; "
        "+https://github.com/islamattia85/sawed)"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IE,en;q=0.9",
}

def get(url: str, timeout: int = 15) -> Optional[requests.Response]:
    try:
        r = requests.get(url, headers=HEADERS, timeout=timeout)
        r.raise_for_status()
        return r
    except Exception as e:
        log.warning(f"GET {url} failed: {e}")
        return None

def parse_rate(text: str) -> Optional[float]:
    """Extract a euro cent per kWh rate and return as decimal (e.g. 31.52 → 0.3152)."""
    m = re.search(r"(\d{1,2}[.,]\d{1,2})\s*c", text, re.IGNORECASE)
    if m:
        val = float(m.group(1).replace(",", "."))
        if 5.0 <= val <= 80.0:
            return round(val / 100, 4)
    return None

def parse_standing(text: str) -> Optional[float]:
    """Extract annual standing charge in euros."""
    m = re.search(r"€?\s*(\d{2,3}[.,]\d{2})", text)
    if m:
        val = float(m.group(1).replace(",", "."))
        if 100 <= val <= 600:
            return round(val, 2)
    return None

def parse_export(text: str) -> Optional[float]:
    """Extract CEG/export rate in cents → decimal."""
    m = re.search(r"(\d{1,2}[.,]\d{1,2})\s*c", text, re.IGNORECASE)
    if m:
        val = float(m.group(1).replace(",", "."))
        if 5.0 <= val <= 30.0:
            return round(val / 100, 4)
    return None

# ---------------------------------------------------------------------------
# Per-supplier scrapers — each returns a dict of plan-id → partial updates
# ---------------------------------------------------------------------------

def scrape_electric_ireland(existing: dict) -> dict:
    updates = {}
    r = get("https://www.electricireland.ie/switch/product")
    if not r:
        return updates
    soup = BeautifulSoup(r.text, "lxml")
    text = soup.get_text(" ", strip=True)

    # Look for unit rate patterns near known plan names
    for plan_id, keywords in {
        "EI-24": ["24hr", "24 hr", "Home Dual+ 24", "flat rate"],
        "EI-SST": ["SST", "Day Night Peak", "Smart Standard", "time of use"],
        "EI-NB": ["Night Boost", "night boost"],
        "EI-DYN": ["Dynamic", "dynamic price"],
    }.items():
        if plan_id not in existing:
            continue
        for kw in keywords:
            idx = text.lower().find(kw.lower())
            if idx == -1:
                continue
            chunk = text[max(0, idx - 200):idx + 400]
            rate = parse_rate(chunk)
            standing = parse_standing(chunk)
            if rate or standing:
                upd = {"verified_date": TODAY}
                if rate:
                    upd["_scraped_day_rate"] = rate
                if standing:
                    upd["_scraped_standing"] = standing
                updates[plan_id] = upd
                log.info(f"EI {plan_id}: rate={rate} standing={standing}")
                break
    return updates


def scrape_bord_gais(existing: dict) -> dict:
    updates = {}
    for url in [
        "https://www.bordgaisenergy.ie/home/electricity-plans",
        "https://www.bordgaisenergy.ie/home/ev-plan-comparison",
    ]:
        r = get(url)
        if not r:
            continue
        soup = BeautifulSoup(r.text, "lxml")
        text = soup.get_text(" ", strip=True)

        for plan_id, keywords in {
            "BG-24": ["All Day", "flat rate", "Smart All Day"],
            "BG-TOU": ["Smart Standard", "Day Night Peak"],
            "BG-EV": ["EV Smart", "EV Plan"],
            "BG-DYN": ["Dynamic", "Smart Dynamic"],
        }.items():
            if plan_id not in existing:
                continue
            for kw in keywords:
                idx = text.lower().find(kw.lower())
                if idx == -1:
                    continue
                chunk = text[max(0, idx - 100):idx + 400]
                rate = parse_rate(chunk)
                standing = parse_standing(chunk)
                if rate or standing:
                    upd = {"verified_date": TODAY}
                    if rate:
                        upd["_scraped_day_rate"] = rate
                    if standing:
                        upd["_scraped_standing"] = standing
                    updates[plan_id] = upd
                    log.info(f"BG {plan_id}: rate={rate} standing={standing}")
                    break
    return updates


def scrape_sse_airtricity(existing: dict) -> dict:
    """SSE publishes tariff PDFs at known paths — try to fetch the PDF index page."""
    updates = {}
    # Try the tariff comparison page
    r = get("https://www.sseairtricity.com/ie/home/electricity-gas/electricity-plans/")
    if not r:
        r = get("https://www.sseairtricity.com/ie/home/electricity-plans/")
    if not r:
        return updates

    soup = BeautifulSoup(r.text, "lxml")
    text = soup.get_text(" ", strip=True)

    for plan_id, keywords in {
        "SSE-EVDAY": ["24hr Smart", "24 Hour Smart", "flat"],
        "SSE-DNP": ["Day Night Peak", "Day/Night/Peak", "Smart DNP"],
        "SSE-EVMAX": ["EV Max", "EVMax"],
    }.items():
        if plan_id not in existing:
            continue
        for kw in keywords:
            idx = text.lower().find(kw.lower())
            if idx == -1:
                continue
            chunk = text[max(0, idx - 100):idx + 400]
            rate = parse_rate(chunk)
            standing = parse_standing(chunk)
            if rate or standing:
                upd = {"verified_date": TODAY}
                if rate:
                    upd["_scraped_day_rate"] = rate
                if standing:
                    upd["_scraped_standing"] = standing
                updates[plan_id] = upd
                log.info(f"SSE {plan_id}: rate={rate} standing={standing}")
                break
    return updates


def scrape_energia(existing: dict) -> dict:
    updates = {}
    r = get("https://www.energia.ie/home/electricity/plans")
    if not r:
        r = get("https://www.energia.ie/home/electricity")
    if not r:
        return updates

    soup = BeautifulSoup(r.text, "lxml")
    text = soup.get_text(" ", strip=True)

    for plan_id, keywords in {
        "EN-24": ["Standard", "24hr", "flat"],
        "EN-SMART": ["Smart Data", "Day Night Peak", "time of use"],
        "EN-EV": ["EV Smart Drive", "EV Drive"],
        "EN-EV-PLUS": ["EV Smart Drive Plus", "EV Drive Plus"],
        "EN-DYN": ["Dynamic", "dynamic rate"],
    }.items():
        if plan_id not in existing:
            continue
        for kw in keywords:
            idx = text.lower().find(kw.lower())
            if idx == -1:
                continue
            chunk = text[max(0, idx - 100):idx + 400]
            rate = parse_rate(chunk)
            standing = parse_standing(chunk)
            if rate or standing:
                upd = {"verified_date": TODAY}
                if rate:
                    upd["_scraped_day_rate"] = rate
                if standing:
                    upd["_scraped_standing"] = standing
                updates[plan_id] = upd
                log.info(f"EN {plan_id}: rate={rate} standing={standing}")
                break
    return updates


def scrape_yuno(existing: dict) -> dict:
    updates = {}
    r = get("https://www.yunoenergy.ie/plans")
    if not r:
        r = get("https://www.yunoenergy.ie/electricity")
    if not r:
        return updates

    soup = BeautifulSoup(r.text, "lxml")
    text = soup.get_text(" ", strip=True)

    for plan_id, keywords in {
        "YN-24": ["Standard Smart", "flat", "24hr"],
        "YN-DNP": ["Day Night Peak", "DNP", "Smart Day"],
        "YN-EV": ["EV Variable", "EV"],
    }.items():
        if plan_id not in existing:
            continue
        for kw in keywords:
            idx = text.lower().find(kw.lower())
            if idx == -1:
                continue
            chunk = text[max(0, idx - 100):idx + 400]
            rate = parse_rate(chunk)
            standing = parse_standing(chunk)
            if rate or standing:
                upd = {"verified_date": TODAY}
                if rate:
                    upd["_scraped_day_rate"] = rate
                if standing:
                    upd["_scraped_standing"] = standing
                updates[plan_id] = upd
                log.info(f"YN {plan_id}: rate={rate} standing={standing}")
                break
    return updates


def scrape_flogas(existing: dict) -> dict:
    updates = {}
    r = get("https://www.flogas.ie/electricity/tariffs")
    if not r:
        r = get("https://www.flogas.ie/electricity")
    if not r:
        return updates

    soup = BeautifulSoup(r.text, "lxml")
    text = soup.get_text(" ", strip=True)

    for plan_id, keywords in {
        "FL-24": ["Smart 24", "flat", "24 hour"],
        "FL-DNP": ["Day Night Peak", "Smart DNP", "day night"],
    }.items():
        if plan_id not in existing:
            continue
        for kw in keywords:
            idx = text.lower().find(kw.lower())
            if idx == -1:
                continue
            chunk = text[max(0, idx - 100):idx + 400]
            rate = parse_rate(chunk)
            standing = parse_standing(chunk)
            if rate or standing:
                upd = {"verified_date": TODAY}
                if rate:
                    upd["_scraped_day_rate"] = rate
                if standing:
                    upd["_scraped_standing"] = standing
                updates[plan_id] = upd
                log.info(f"FL {plan_id}: rate={rate} standing={standing}")
                break
    return updates


def scrape_pinergy(existing: dict) -> dict:
    updates = {}
    r = get("https://www.pinergy.ie/rates")
    if not r:
        r = get("https://www.pinergy.ie/home-electricity")
    if not r:
        return updates

    soup = BeautifulSoup(r.text, "lxml")
    text = soup.get_text(" ", strip=True)

    for plan_id, keywords in {
        "PIN-LF": ["Lifestyle Standard", "Standard Smart"],
        "PIN-WFH": ["Working from Home", "WFH"],
        "PIN-FAM": ["Family Time", "Family"],
        "PIN-EV": ["EV Night", "EV Night Time"],
    }.items():
        if plan_id not in existing:
            continue
        for kw in keywords:
            idx = text.lower().find(kw.lower())
            if idx == -1:
                continue
            chunk = text[max(0, idx - 100):idx + 400]
            rate = parse_rate(chunk)
            standing = parse_standing(chunk)
            # Check if plan now shows as discontinued
            if "no longer" in chunk.lower() or "discontinued" in chunk.lower():
                updates[plan_id] = {"discontinued": True, "discontinued_date": TODAY,
                                    "verified_date": TODAY}
                log.info(f"PIN {plan_id}: marked discontinued")
                break
            if rate or standing:
                upd = {"verified_date": TODAY}
                if rate:
                    upd["_scraped_day_rate"] = rate
                if standing:
                    upd["_scraped_standing"] = standing
                updates[plan_id] = upd
                log.info(f"PIN {plan_id}: rate={rate} standing={standing}")
                break
    return updates


# ---------------------------------------------------------------------------
# Apply scraped updates to the tariff list
# ---------------------------------------------------------------------------

RATE_TOLERANCE = 0.05   # Reject if scraped day rate differs >5c from existing (likely bad parse)

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
            if abs(scraped_day - existing_day) > RATE_TOLERANCE:
                log.warning(
                    f"{plan_id}: scraped day {scraped_day:.4f} vs existing {existing_day:.4f} "
                    f"— delta {abs(scraped_day-existing_day):.4f} > tolerance, skipping rate update"
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
            if abs(scraped_standing - existing_standing) > 100:
                log.warning(
                    f"{plan_id}: scraped standing {scraped_standing} vs existing "
                    f"{existing_standing} — delta too large, skipping"
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
# Detect new plans via CRU comparison tool (bonus scan)
# ---------------------------------------------------------------------------

def scan_cru_for_new_plans(existing_ids: set) -> list:
    """
    The CRU publishes a tariff comparison at www.cru.ie.
    Try to detect supplier names that aren't in our list.
    Returns list of warning strings — we don't auto-add plans.
    """
    warnings = []
    r = get("https://www.cru.ie/home/switching-supplier/electricity-and-gas-price-comparison/")
    if not r:
        return warnings
    soup = BeautifulSoup(r.text, "lxml")
    text = soup.get_text(" ", strip=True)

    known_suppliers = {
        "electric ireland", "bord gáis", "bord gais", "energia",
        "sse airtricity", "yuno", "flogas", "pinergy",
        "prepay power", "community power",
    }
    # Look for any company name patterns not in our set
    for m in re.finditer(r"\b([A-Z][a-zA-Z& ]{3,30})\s+(?:Energy|Electricity|Power)", text):
        name = m.group(0).strip().lower()
        if not any(k in name for k in known_suppliers):
            warnings.append(f"Possible new supplier detected on CRU page: {m.group(0).strip()!r}")
    return list(set(warnings))


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

    # Run all scrapers
    all_updates: dict = {}
    scrapers = [
        scrape_electric_ireland,
        scrape_bord_gais,
        scrape_sse_airtricity,
        scrape_energia,
        scrape_yuno,
        scrape_flogas,
        scrape_pinergy,
    ]
    for scraper_fn in scrapers:
        name = scraper_fn.__name__
        try:
            updates = scraper_fn(existing)
            log.info(f"{name}: {len(updates)} plan(s) updated")
            all_updates.update(updates)
        except Exception as e:
            log.error(f"{name} crashed: {e}")

    # Apply updates
    updated_tariffs, n_changes = apply_updates(tariffs, all_updates)

    # Scan CRU for new suppliers
    existing_ids = set(existing.keys())
    cru_warnings = scan_cru_for_new_plans(existing_ids)
    for w in cru_warnings:
        log.warning(f"CRU SCAN: {w}")

    # Always bump meta even if no rate changes (proves the scraper ran)
    meta_idx = next((i for i, t in enumerate(updated_tariffs) if t.get("id") == "__meta__"), None)
    meta = {
        "id": "__meta__",
        "last_scraped": TODAY,
        "scraper_version": "1.0",
        "cru_warnings": cru_warnings,
    }
    if meta_idx is not None:
        updated_tariffs[meta_idx] = meta
    else:
        updated_tariffs.insert(0, meta)

    with open(TARIFFS_PATH, "w") as f:
        json.dump(updated_tariffs, f, indent=2, ensure_ascii=False)

    log.info(f"Done. {n_changes} field(s) updated. tariffs.json written.")

    if cru_warnings:
        print("\n=== ACTION REQUIRED: Possible new suppliers detected ===")
        for w in cru_warnings:
            print(f"  {w}")
        print("Review and manually add any new plans to tariffs.json.\n")


if __name__ == "__main__":
    main()
