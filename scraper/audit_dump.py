#!/usr/bin/env python3
"""
Capture the evidence: everything every Irish residential supplier publishes
about its electricity prices, as it stands today.

The registry has been built piecemeal — a parser here, a hand check there, a
harvest for new plans — and half of it cannot say, field by field, where its
numbers came from. This is the reset. For each supplier it:

  * starts from the entry points we know, and crawls the same site for pages
    whose link text or path looks like prices, tariffs or plans;
  * opens every page in a real browser (Chromium via Playwright), so a site
    that renders its prices with script is read like a person sees it;
  * records every JSON response the page loads while rendering — single-page
    sites usually fetch their price table as data, which is the cleanest
    source of all;
  * reads every table cell by cell, and every linked PDF (text and tables).

It writes one JSON file per supplier under evidence/, plus a README index,
and changes nothing in the app. Runs on a CI runner: the supplier sites are
unreachable from the dev container.
"""

from __future__ import annotations

import io
import json
import re
import sys
import time
from datetime import date
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

OUT = Path(__file__).resolve().parent.parent / "evidence"

SUPPLIERS = {
    "Electric Ireland": ["https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E",
                         "https://www.electricireland.ie/residential/electricity-and-gas/smart-meter-price-plans",
                         "https://www.electricireland.ie/residential/price-changes",
                         "https://www.electricireland.ie/residential/products/electricity",
                         "https://www.electricireland.ie/residential/help/micro-generation"],
    "Bord Gáis Energy": ["https://www.bordgaisenergy.ie/home/our-tariffs",
                         "https://www.bordgaisenergy.ie/home/ev-plan-comparison",
                         "https://www.bordgaisenergy.ie/home/price-change-info",
                         "https://www.bordgaisenergy.ie/home/our-plans"],
    "SSE Airtricity": ["https://www.sseairtricity.com/ie/home/our-tariffs/",
                       "https://www.sseairtricity.com/ie/home/products/electricity",
                       "https://www.sseairtricity.com/ie/home/news/home-energy-price-change-roi-customers",
                       "https://www.sseairtricity.com/ie/home/products/microgeneration"],
    "Energia": ["https://www.energia.ie/about-energia/our-tariffs",
                "https://www.energia.ie/energy-plans/electricity"],
    "Yuno Energy": ["https://www.yunoenergy.ie/", "https://www.yunoenergy.ie/our-tariffs",
                    "https://www.yunoenergy.ie/plans"],
    # Flogas renders from its pricing API; the query string selects the offer
    # set (new customers, electricity only, by meter).
    "Flogas": ["https://www.flogas.ie/price-plans/?newCustomer=Yes&lookingFor=Electricity&meterType=Smart",
               "https://www.flogas.ie/price-plans/?newCustomer=Yes&lookingFor=Electricity&meterType=Standard",
               "https://www.flogas.ie/flogas-tariff-rates", "https://www.flogas.ie/solar-panels/micro-generation"],
    "Pinergy": ["https://www.pinergy.ie/terms-conditions/tariffs/", "https://www.pinergy.ie/lifestyle-plans/",
                "https://pinergy.ie/microgeneration/"],
    "PrePayPower": ["https://www.prepaypower.ie/why-switch/pricing/rates",
                    "https://www.prepaypower.ie/why-switch/pricing/estimated-annual-bill-faqs"],
    "Waterpower": ["https://www.waterpower.ie/current-electricity-rates/"],
    "Community Power": ["https://www.communitypower.ie/tariffs"],
    "Ecopower": ["https://www.ecopower.ie/"],
}

PRICE_LINK = re.compile(
    r"tariff|price|pricing|rate|plan|smart|\bev\b|electric|standing|export|microgen|ceg|\.pdf", re.I)
SKIP_LINK = re.compile(
    r"gas-only|/gas/|business|commercial|careers|login|account|mailto:|tel:|javascript:|"
    r"privacy|cookie|facebook|twitter|linkedin|instagram|youtube|\.(jpg|png|svg|webp)(\?|$)", re.I)
MAX_PAGES = 18
MAX_PDFS = 14
PRICEY_JSON = re.compile(r"(rate|price|tariff|kwh|standing|unit)", re.I)


def tables_from_html(html: str) -> list[list[list[str]]]:
    soup = BeautifulSoup(html, "lxml")
    out = []
    for t in soup.find_all("table"):
        rows = [[" ".join(c.get_text(" ", strip=True).split()) for c in tr.find_all(["th", "td"])]
                for tr in t.find_all("tr")]
        rows = [r for r in rows if any(r)]
        if rows and not any("cookie" in " ".join(r).lower() for r in rows[:2]):
            out.append(rows)
    return out


def text_from_html(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    for t in soup(["script", "style", "noscript", "svg"]):
        t.decompose()
    lines = [ln.strip() for ln in soup.get_text("\n", strip=True).splitlines() if ln.strip()]
    return "\n".join(lines)


def links_from_html(html: str, base: str) -> list[tuple[str, str]]:
    soup = BeautifulSoup(html, "lxml")
    out = []
    for a in soup.find_all("a", href=True):
        u = urljoin(base, a["href"].strip()).split("#")[0]
        label = " ".join(a.get_text(" ", strip=True).split())[:100]
        out.append((label, u))
    return out


def read_pdf(data: bytes) -> dict:
    try:
        import pdfplumber
    except Exception as e:
        return {"error": f"pdfplumber unavailable: {e}"}
    try:
        text, tables = [], []
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for page in pdf.pages[:12]:
                text.append(page.extract_text() or "")
                for t in page.extract_tables() or []:
                    tables.append([[(c or "").strip() for c in row] for row in t])
        return {"text": "\n".join(text)[:60000], "tables": tables[:40]}
    except Exception as e:
        return {"error": f"unreadable PDF: {e}"}


def capture(supplier: str, entries: list[str], browser) -> dict:
    host = urlparse(entries[0]).netloc.replace("www.", "")
    queue = list(entries)
    seen: set[str] = set()
    pages, pdfs = [], []
    ctx = browser.new_context(user_agent=(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0 Safari/537.36"), locale="en-IE")
    while queue and len(pages) < MAX_PAGES:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        if url.lower().split("?")[0].endswith(".pdf"):
            if len(pdfs) < MAX_PDFS:
                pdfs.append(url)
            continue
        page = ctx.new_page()
        payloads = []

        def on_response(resp):
            try:
                ct = resp.headers.get("content-type", "")
                if "json" in ct and len(payloads) < 40:
                    body = resp.text()
                    # A supplier's own pricing API is kept whole: a truncated
                    # payload cannot be parsed, and it is the cleanest source.
                    limit = 3_000_000 if "pricing" in resp.url else 120_000
                    if PRICEY_JSON.search(body) and len(body) < limit:
                        payloads.append({"url": resp.url, "body": body[:limit]})
            except Exception:
                pass

        page.on("response", on_response)
        rec = {"url": url}
        try:
            # "networkidle" never settles on sites with analytics beacons, and
            # cost 45s a page; load the DOM, then give scripts a few seconds.
            resp = page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            rec["status"] = resp.status if resp else None
            time.sleep(4)
            # open anything collapsed — accordions often hide the price table
            for sel in ["button[aria-expanded='false']", "summary", "[data-toggle='collapse']"]:
                for el in page.query_selector_all(sel)[:30]:
                    try:
                        el.click(timeout=800)
                    except Exception:
                        pass
            html = page.content()
            rec["final_url"] = page.url
            rec["title"] = page.title()
            rec["text"] = text_from_html(html)[:80_000]
            rec["tables"] = tables_from_html(html)
            # The raw page too, so the scraper's parsers can be run offline
            # against exactly what was captured.
            rec["html"] = html[:600_000]
            rec["json"] = payloads
            for label, u in links_from_html(html, page.url):
                h = urlparse(u).netloc.replace("www.", "")
                is_pdf = u.lower().split("?")[0].endswith(".pdf")
                if SKIP_LINK.search(u):
                    continue
                if (h == host or is_pdf) and PRICE_LINK.search(f"{label} {u}") and u not in seen:
                    (queue.insert(0, u) if is_pdf else queue.append(u))
        except Exception as e:
            rec["error"] = f"{type(e).__name__}: {str(e)[:200]}"
        finally:
            page.close()
        pages.append(rec)
    ctx.close()

    pdf_recs = []
    for u in pdfs:
        try:
            r = requests.get(u, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
            rec = {"url": u, "status": r.status_code}
            if r.ok and r.content[:4] == b"%PDF":
                rec.update(read_pdf(r.content))
            pdf_recs.append(rec)
        except Exception as e:
            pdf_recs.append({"url": u, "error": str(e)[:200]})

    return {"supplier": supplier, "captured": date.today().isoformat(),
            "pages": pages, "pdfs": pdf_recs}


def summary_line(d: dict) -> str:
    ok = [p for p in d["pages"] if p.get("status") and p["status"] < 400]
    tables = sum(len(p.get("tables", [])) for p in d["pages"])
    js = sum(len(p.get("json", [])) for p in d["pages"])
    pdf_ok = [p for p in d["pdfs"] if p.get("text")]
    rates = set()
    blob = " ".join(p.get("text", "") for p in d["pages"]) + " ".join(p.get("text", "") for p in d["pdfs"])
    for m in re.finditer(r"(\d{1,2}[.,]\d{2})\s*c(?:ent)?", blob):
        rates.add(m.group(1))
    return (f"| {d['supplier']} | {len(ok)}/{len(d['pages'])} | {tables} | {js} | "
            f"{len(pdf_ok)}/{len(d['pdfs'])} | {len(rates)} |")


def main() -> int:
    from playwright.sync_api import sync_playwright
    wanted = {a.lower() for a in sys.argv[1:]}
    OUT.mkdir(exist_ok=True)
    rows = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for supplier, entries in SUPPLIERS.items():
            if wanted and not any(w in supplier.lower() for w in wanted):
                continue
            print(f"== {supplier}", flush=True)
            try:
                d = capture(supplier, entries, browser)
            except Exception as e:
                d = {"supplier": supplier, "captured": date.today().isoformat(),
                     "pages": [], "pdfs": [], "error": str(e)[:300]}
            slug = re.sub(r"[^a-z0-9]+", "-", supplier.lower()).strip("-")
            (OUT / f"{slug}.json").write_text(json.dumps(d, ensure_ascii=False, indent=1))
            rows.append(summary_line(d))
            print("  " + rows[-1], flush=True)
        browser.close()
    (OUT / "README.md").write_text(
        f"# Supplier price evidence — captured {date.today().isoformat()}\n\n"
        "Raw capture by scraper/audit_dump.py: rendered page text, tables, JSON the pages "
        "loaded, and linked PDFs. Nothing here is interpreted; it is what each supplier "
        "published on the day.\n\n"
        "| Supplier | pages read | tables | JSON payloads | PDFs read | c/kWh figures seen |\n"
        "|---|---|---|---|---|---|\n" + "\n".join(rows) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
