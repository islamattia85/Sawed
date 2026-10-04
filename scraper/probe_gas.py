#!/usr/bin/env python3
"""
Can the five dual-fuel suppliers' gas prices be read every day?

Before gas is added to the comparison (dual-fuel homes), this reads each
supplier's own gas price pages and price-list PDFs and prints every gas
rate-, standing-charge-, carbon-tax- and dual-fuel-shaped line, so we can see
which sites publish gas prices in a form a daily check can rely on. A second
pass renders the pages in a browser for sites that draw prices with script.

Runs on CI only; supplier sites are unreachable from the dev container.
It prints. It writes nothing and changes nothing.
"""

from __future__ import annotations

import re
import sys

import probe_new_suppliers as P

P.SUPPLIERS = {
    "Electric Ireland": {
        "roots": ["https://www.electricireland.ie/"],
        "seeds": ["/residential/price-plans/gas", "/residential/price-plans", "/residential/help/price-plans",
                  "/residential/price-plans/dual-fuel", "/switch/new-customer/price-plans?priceType=G"],
    },
    "Bord Gáis Energy": {
        "roots": ["https://www.bordgaisenergy.ie/"],
        "seeds": ["/home/our-tariffs", "/home/our-plans?isNewCustomer=YES&fuelType=GAS",
                  "/home/our-plans?isNewCustomer=YES&fuelType=DUAL", "/home/gas"],
    },
    "Energia": {
        "roots": ["https://www.energia.ie/"],
        "seeds": ["/about-energia/our-tariffs", "/energy-plans/gas", "/energy-plans/dual-fuel", "/energy-plans"],
    },
    "SSE Airtricity": {
        "roots": ["https://www.sseairtricity.com/ie/home/", "https://sseairtricity.com/ie/home/"],
        "seeds": ["/ie/home/help-centre/our-tariffs/", "/ie/home/products/gas/", "/ie/home/products/gas-and-electricity/",
                  "/ie/home/products/"],
    },
    "Flogas": {
        "roots": ["https://www.flogas.ie/"],
        "seeds": ["/en/residential/natural-gas/", "/en/residential/natural-gas/price-plans/",
                  "/en/residential/our-tariffs/", "/en/residential/dual-fuel/", "/en/residential/price-plans/"],
    },
}
P.PRICEY = re.compile(
    r"(\bgas\b|carbon|dual|\d{1,2}[.,]\d{1,4}\s*c(?:ent)?s?\b|c\s*/\s*kwh|per\s*kwh|standing|unit\s*rate|"
    r"€\s*\d{2,4}(?:[.,]\d{1,2})?|discount|welcome|credit)", re.I)
P.MAX_PAGES = 8
P.MAX_LINES = 80


def render_pass(names: list[str]) -> None:
    """Pages drawn by script: render each seed in a browser and print its gas lines."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright not installed; skipping the rendered pass")
        return
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = b.new_page(user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36")
        for name in names:
            cfg = P.SUPPLIERS[name]
            root = cfg["roots"][0].split("/ie/home/")[0].rstrip("/") if "sseairtricity" in cfg["roots"][0] else cfg["roots"][0].rstrip("/")
            print(P.RULE); print(f"{name} — rendered"); print(P.RULE)
            for s in cfg["seeds"]:
                u = root + s
                try:
                    page.goto(u, wait_until="networkidle", timeout=45000)
                    page.wait_for_timeout(1500)
                    P.show_text(f"rendered {u}", page.inner_text("body"))
                except Exception as e:  # noqa: BLE001 — a probe reports, it does not stop
                    print(f"    rendered {u}: {str(e)[:120]}")
        b.close()


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    names = [n for n in P.SUPPLIERS if not args or any(a.lower() in n.lower() for a in args)]
    if "--render" in sys.argv:
        render_pass(names)
    else:
        for n in names:
            P.probe(n, P.SUPPLIERS[n])
