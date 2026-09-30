#!/usr/bin/env python3
"""
What four suppliers the app does not yet carry publish about their prices.

PrePayPower, Waterpower, Community Power and Ecopower appeared in a research
workbook with rates copied, rounded, from comparison sites — and most of their
smart plans with no standing charge at all. Nothing ranks on figures like
that. This reads each supplier's own site instead: finds its price pages and
price-list PDFs, and prints every rate- or standing-charge-shaped line in
context, so parsers can be written against what the supplier actually says.

Runs on CI only; the supplier sites are unreachable from the dev container.
It prints. It writes nothing and changes nothing.
"""

from __future__ import annotations

import re
import sys
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from sources import fetch, discover, pdf_text, rates_from_text, standing_from_text

RULE = "=" * 72

# Hosts to try, first that answers wins. Seeds are guesses at where a price
# page usually lives; a guess that 404s is reported, not trusted.
SUPPLIERS = {
    "PrePayPower": {
        "roots": ["https://www.prepaypower.ie/", "https://prepaypower.ie/"],
        "seeds": ["/electricity", "/prices", "/our-prices", "/tariffs", "/electricity-prices",
                  "/smart-pay", "/price-list"],
    },
    "Waterpower": {
        "roots": ["https://www.waterpower.ie/", "https://waterpower.ie/"],
        "seeds": ["/prices", "/tariffs", "/electricity-prices", "/our-prices", "/price-list"],
    },
    "Community Power": {
        "roots": ["https://www.communitypower.ie/", "https://communitypower.ie/"],
        "seeds": ["/prices", "/tariffs", "/our-tariffs", "/electricity-prices", "/price-list"],
    },
    "Ecopower": {
        "roots": ["https://www.ecopower.ie/", "https://ecopower.ie/"],
        "seeds": ["/prices", "/tariffs", "/domestic", "/electricity-prices", "/price-list"],
    },
}

PRICEY = re.compile(
    r"(\d{1,2}[.,]\d{1,4}\s*c(?:ent)?s?\b|c\s*/\s*kwh|per\s*kwh|€\s*\d{2,4}(?:[.,]\d{1,2})?|"
    r"standing|unit\s*rate|night|peak|24\s*h|day\s*rate|pso|vat)",
    re.I)
MAX_PAGES = 10
MAX_LINES = 60


def text_of(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    for t in soup(["script", "style", "noscript"]):
        t.decompose()
    return soup.get_text("\n", strip=True)


def pdf_links(html: str, base: str) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    host = urlparse(base).netloc
    out = []
    for a in soup.find_all("a", href=True):
        u = urljoin(base, a["href"].strip())
        if u.lower().split("?")[0].endswith(".pdf") and u not in out:
            # price lists are sometimes served from a CDN on another host — keep them
            out.append(u)
    return out


def show_text(label: str, text: str) -> None:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    hits = [ln for ln in lines if PRICEY.search(ln) and len(ln) < 220]
    print(f"    {label}: {len(lines)} lines, {len(hits)} price-shaped")
    print(f"      rates found  : {sorted(set(rates_from_text(text)))[:24]}")
    print(f"      standing found: {sorted(set(standing_from_text(text)))[:12]}")
    for ln in hits[:MAX_LINES]:
        print(f"      | {ln}")


def probe(name: str, cfg: dict) -> None:
    print(RULE)
    print(name)
    print(RULE)
    session = requests.Session()
    root = None
    for r in cfg["roots"]:
        got = fetch(r, session=session)
        print(f"  root {r} -> {got.kind} {got.status or ''} {got.detail[:80]}")
        if got.ok:
            root = r
            break
    if not root:
        print("  NO ROOT ANSWERED — nothing more to read.")
        return

    pages = discover(root, session=session, seeds=cfg["seeds"])[:MAX_PAGES]
    print(f"  candidate pages ({len(pages)}): ")
    for u in pages:
        print(f"    - {u}")

    seen_pdfs: list[str] = []
    for u in pages:
        got = fetch(u, session=session)
        print(f"\n  PAGE {u} -> {got.kind} {got.status or ''}")
        if not got.ok:
            continue
        if u.lower().endswith(".pdf") or got.content[:4] == b"%PDF":
            show_text("pdf", pdf_text(got.content))
            continue
        show_text("html", text_of(got.text))
        for p in pdf_links(got.text, u):
            if p not in seen_pdfs:
                seen_pdfs.append(p)

    print(f"\n  price-list PDFs linked ({len(seen_pdfs)}):")
    for p in seen_pdfs[:8]:
        got = fetch(p, session=session)
        print(f"\n  PDF {p} -> {got.kind} {got.status or ''}")
        if got.ok:
            show_text("pdf", pdf_text(got.content))


# ---------------------------------------------------------------- second pass
# The first pass flattened tables into one column (PrePayPower's became
# ambiguous), found no export rate anywhere, and read nothing from Waterpower
# or Ecopower. These read structure rather than prose.

DEEP = {
    "PrePayPower": ["https://www.prepaypower.ie/why-switch/pricing/estimated-annual-bill-faqs",
                    "https://www.prepaypower.ie/why-switch/pricing"],
    "Community Power": ["https://www.communitypower.ie/tariffs"],
    "Waterpower": ["https://www.waterpower.ie/wpe-sst-smart-tariff/", "https://www.waterpower.ie/"],
    "Ecopower": ["https://www.ecopower.ie/", "https://www.ecopower.ie/electricity-prices"],
}
EXPORT = re.compile(r"export|micro-?gen|clean\s*export|\bceg\b|feed.?in|solar", re.I)


def tables(html: str) -> None:
    soup = BeautifulSoup(html, "lxml")
    tabs = soup.find_all("table")
    print(f"    tables: {len(tabs)}")
    for ti, t in enumerate(tabs[:6]):
        print(f"    --- table {ti}")
        for tr in t.find_all("tr")[:40]:
            cells = [" ".join(c.get_text(" ", strip=True).split()) for c in tr.find_all(["th", "td"])]
            if any(cells):
                print("      " + " | ".join(cells))


def structure(html: str, base: str) -> None:
    soup = BeautifulSoup(html, "lxml")
    imgs = [(i.get("alt") or "", i.get("src") or "") for i in soup.find_all("img")]
    frames = [f.get("src") for f in soup.find_all("iframe")]
    print(f"    images: {len(imgs)}  iframes: {frames[:5]}")
    for alt, src in imgs[:25]:
        if re.search(r"tariff|price|rate|sst|smart", f"{alt} {src}", re.I):
            print(f"      img alt={alt[:60]!r} src={urljoin(base, src)}")
    links = []
    for a in soup.find_all("a", href=True):
        u = urljoin(base, a["href"].strip())
        label = " ".join(a.get_text(" ", strip=True).split())[:60]
        links.append((label, u))
    print(f"    links: {len(links)}")
    for label, u in links:
        if re.search(r"tariff|price|rate|export|micro|ceg|solar|smart|domestic|home|pdf", f"{label} {u}", re.I):
            print(f"      {label!r:40} {u}")
    scripts = " ".join(s.get_text() for s in soup.find_all("script"))
    for m in list(re.finditer(r"(\d{1,2}\.\d{1,2})\s*c", scripts))[:10]:
        print(f"      script rate-ish: ...{scripts[max(0, m.start()-60):m.end()+20]!r}")


def export_lines(text: str) -> None:
    hits = [ln.strip() for ln in text.splitlines() if EXPORT.search(ln) and len(ln.strip()) < 240]
    for ln in hits[:15]:
        print(f"      export? | {ln}")


def deep(name: str) -> None:
    print(RULE)
    print(f"DEEP {name}")
    print(RULE)
    s = requests.Session()
    for u in DEEP.get(name, []):
        got = fetch(u, session=s)
        print(f"  PAGE {u} -> {got.kind} {got.status or ''} ({len(got.text)} chars)")
        if not got.ok:
            continue
        tables(got.text)
        structure(got.text, u)
        export_lines(text_of(got.text))
    # every supplier: go looking for an export / microgeneration page
    root = DEEP[name][0].split("/", 3)[:3]
    root = "/".join(root) + "/"
    home = fetch(root, session=s)
    if home.ok:
        soup = BeautifulSoup(home.text, "lxml")
        cands = []
        for a in soup.find_all("a", href=True):
            u = urljoin(root, a["href"])
            if EXPORT.search(f"{a.get_text(' ', strip=True)} {u}") and u not in cands:
                cands.append(u)
        print(f"  export-looking links from home: {cands[:8]}")
        for u in cands[:4]:
            got = fetch(u, session=s)
            print(f"  EXPORT PAGE {u} -> {got.kind} {got.status or ''}")
            if got.ok:
                t = pdf_text(got.content) if got.content[:4] == b"%PDF" else text_of(got.text)
                export_lines(t)
                print(f"      rates in page: {sorted(set(rates_from_text(t)))[:12]}")


if __name__ == "__main__" and "--deep" in sys.argv:
    for name in DEEP:
        try:
            deep(name)
        except Exception as e:
            print(f"  DEEP FAILED: {type(e).__name__}: {e}")
    sys.exit(0)

if __name__ == "__main__":
    wanted = {a.lower() for a in sys.argv[1:]}
    for name, cfg in SUPPLIERS.items():
        if wanted and not any(w in name.lower() for w in wanted):
            continue
        try:
            probe(name, cfg)
        except Exception as e:           # one broken site must not hide the others
            print(f"  PROBE FAILED: {type(e).__name__}: {e}")
