#!/usr/bin/env python3
"""
Targeted probes to design the parsers against — not a survey, specific answers.

Run on a runner (sites are unreachable locally). Prints only.
"""
from __future__ import annotations
import json, re, sys
from urllib.parse import urljoin
import requests
from bs4 import BeautifulSoup
from sources import fetch, embedded_json, walk, pdf_text

S = requests.Session()
RULE = "=" * 72


def bord_gais():
    print(f"\n{RULE}\nBORD GÁIS · product entries (name → smartRates)\n{RULE}")
    url = "https://www.bordgaisenergy.ie/home/our-plans?fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES"
    got = fetch(url, session=S)
    print(f"  {url}\n  {got.kind} {got.status}")
    if not got.ok:
        # fall back to dual fuel
        url = "https://www.bordgaisenergy.ie/home/our-plans?fuelType=DUAL_FUEL&smartMeter=SMARTMETER_YES"
        got = fetch(url, session=S)
        print(f"  fallback {url}\n  {got.kind} {got.status}")
        if not got.ok:
            return
    for blob in embedded_json(got.text):
        # find products.list.<FUEL>.entries dict
        def rec(node, path=""):
            if isinstance(node, dict):
                if path.endswith(".entries"):
                    for sfid, entry in node.items():
                        if not isinstance(entry, dict):
                            continue
                        name = entry.get("productName") or entry.get("name") or entry.get("planName") or entry.get("displayName") or entry.get("title")
                        namekeys = {k: v for k, v in entry.items() if isinstance(v, str) and 3 < len(v) < 60 and not v.startswith("http")}
                        ed = entry.get("electricityDetail", {})
                        est = (ed or {}).get("estimated", {})
                        sr = (est or {}).get("smartRates", {})
                        fr = (est or {}).get("flatRate") or est.get("unitRate")
                        print(f"    [{sfid}] name={name!r}")
                        print(f"       string-fields: { {k:namekeys[k] for k in list(namekeys)[:8]} }")
                        print(f"       smartRates={sr}  flat/unit={fr}  standing={est.get('standingCharge') or est.get('oStandingCharge')}")
                for k, v in node.items():
                    rec(v, f"{path}.{k}" if path else k)
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    rec(v, f"{path}[{i}]")
        rec(blob)


def energia():
    print(f"\n{RULE}\nENERGIA · /energy-plans/electricity visible text\n{RULE}")
    url = "https://www.energia.ie/energy-plans/electricity"
    got = fetch(url, session=S)
    print(f"  {got.kind} {got.status}")
    if got.ok:
        text = BeautifulSoup(got.text, "lxml").get_text(" ", strip=True)
        # dump the region around the first cent figure, generously
        m = re.search(r"\d{1,2}\.\d{1,2}\s*c", text)
        if m:
            print("  ----- TEXT around rates (1800 chars) -----")
            print(text[max(0, m.start()-200): m.start()+1600])
            print("  ----- END -----")
        else:
            print("  no cent figure; first 1500 chars:")
            print(text[:1500])


def sse():
    print(f"\n{RULE}\nSSE · PDF links on current-offers, and one PDF's text\n{RULE}")
    url = "https://www.sseairtricity.com/ie/home/help-centre/our-tariffs/current-offers"
    got = fetch(url, session=S)
    print(f"  {got.kind} {got.status}")
    if not got.ok:
        return
    soup = BeautifulSoup(got.text, "lxml")
    pdfs = []
    for a in soup.find_all("a", href=True):
        h = a["href"]
        if ".pdf" in h.lower():
            pdfs.append(urljoin(url, h))
    pdfs = list(dict.fromkeys(pdfs))
    print(f"  {len(pdfs)} PDF links:")
    for p in pdfs[:12]:
        print(f"    {p}")
    if pdfs:
        got2 = fetch(pdfs[0], session=S)
        if got2.ok:
            txt = pdf_text(got2.content)
            print(f"  ----- {pdfs[0]} ({len(txt)} chars) -----")
            print(txt[:2500])
            print("  ----- END -----")


def pinergy():
    print(f"\n{RULE}\nPINERGY · candidate tariff pages\n{RULE}")
    for path in ["/terms-conditions/tariffs/", "/home-electricity/smart-electricity-plans/",
                 "/home-electricity/", "/price-plans/", "/tariffs/"]:
        u = urljoin("https://www.pinergy.ie/", path)
        got = fetch(u, session=S)
        note = ""
        if got.ok:
            text = BeautifulSoup(got.text, "lxml").get_text(" ", strip=True)
            m = re.search(r"\d{1,2}\.\d{1,2}\s*c", text)
            note = f"text {len(text)}c, cent-figure={'YES' if m else 'no'}"
            if m:
                note += " :: ..." + text[m.start()-80:m.start()+220] + "..."
        print(f"    {got.kind:8} {got.status}  {u}  {note}")


def ei():
    print(f"\n{RULE}\nELECTRIC IRELAND · price-plan pages with rates\n{RULE}")
    for path in ["/residential/electricity-and-gas/smart-meter-price-plans",
                 "/residential/electricity-and-gas/electricity-price-plans",
                 "/residential/products/smart-meters/plans",
                 "/switch/new-customer/price-plans?priceType=D"]:
        u = urljoin("https://www.electricireland.ie/", path)
        got = fetch(u, session=S)
        note = ""
        if got.ok:
            text = BeautifulSoup(got.text, "lxml").get_text(" ", strip=True)
            m = re.search(r"\d{1,2}\.\d{1,2}\s*c", text)
            note = f"text {len(text)}c cent={'YES' if m else 'no'}"
            if m:
                note += " :: ..." + text[m.start()-120:m.start()+260] + "..."
        print(f"    {got.kind:8} {got.status}  {u}  {note}")


if __name__ == "__main__":
    which = sys.argv[1:] or ["bg", "energia", "sse", "pinergy", "ei"]
    fns = {"bg": bord_gais, "energia": energia, "sse": sse, "pinergy": pinergy, "ei": ei}
    for k in which:
        try:
            fns[k]()
        except Exception as e:
            print(f"  {k} CRASHED: {type(e).__name__}: {e}")
