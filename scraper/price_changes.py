#!/usr/bin/env python3
"""
Find ANNOUNCED-but-not-yet-effective price changes, run from a CI runner.

Irish suppliers must give notice before a price move, so a rise is public weeks
before it bites. This surfaces those announcements — from each supplier's own
price-change page and from the CRU-accredited comparison trackers — as text for
a human to turn into a structured price_change {effective_date, pct} on the
affected plans. It prints only; it never writes tariffs.json, and it never
auto-applies a percentage, because a misread date or figure here would misprice
a recommendation.
"""
from __future__ import annotations

import re
import sys

import requests
from bs4 import BeautifulSoup

from sources import fetch

S = requests.Session()
RULE = "=" * 72

# Supplier price-change / notice pages, plus the accredited trackers.
SOURCES = [
    ("Electric Ireland", "https://www.electricireland.ie/residential/price-changes"),
    ("Electric Ireland", "https://www.electricireland.ie/switch/our-products/price-changes"),
    ("SSE Airtricity", "https://www.sseairtricity.com/ie/home/help-centre/price-changes/"),
    ("Bord Gáis", "https://www.bordgaisenergy.ie/home/our-price-changes"),
    ("Energia", "https://www.energia.ie/price-changes"),
    ("Pinergy", "https://www.pinergy.ie/price-changes/"),
    ("bonkers.ie", "https://www.bonkers.ie/blog/gas-electricity/"),
    ("switcher.ie", "https://switcher.ie/gas-electricity/"),
    ("CRU", "https://www.cru.ie/home/switching-supplier/electricity-and-gas-price-comparison/"),
]

# A sentence announcing a change: a supplier/plan, a percentage, a direction,
# and ideally a date. We dump the neighbourhood of any percentage that sits
# near change-language so a human can read the actual claim.
PCT = re.compile(r"\d{1,2}(?:\.\d+)?\s*(?:per\s*cent|%)", re.I)
CHANGE = re.compile(r"increase|rise|rising|decrease|reduc|cut|change|from\s+\d|"
                    r"effective|1\s+\w+\s+20\d\d|\d{1,2}\s+\w+\s+20\d\d", re.I)


def probe(name: str, url: str) -> None:
    got = fetch(url, session=S)
    print(f"\n{RULE}\n{name}: {got.kind} {got.status}\n{url}\n{RULE}")
    if not got.ok:
        return
    text = BeautifulSoup(got.text, "lxml").get_text(" ", strip=True)
    seen = 0
    for m in PCT.finditer(text):
        lo, hi = max(0, m.start() - 160), min(len(text), m.end() + 160)
        window = text[lo:hi]
        if CHANGE.search(window):
            print(f"  … {window.strip()} …")
            seen += 1
            if seen >= 8:
                print("  (more matches, truncated)")
                break
    if not seen:
        print("  no change-language near a percentage on this page")


def main() -> None:
    wanted = {a.lower() for a in sys.argv[1:]}
    for name, url in SOURCES:
        if wanted and name.lower() not in wanted:
            continue
        try:
            probe(name, url)
        except Exception as e:
            print(f"  {name} CRASHED: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
