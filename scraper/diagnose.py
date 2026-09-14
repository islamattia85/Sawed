#!/usr/bin/env python3
"""
What the supplier sites look like RIGHT NOW, from a runner.

The scraper is stuck at 24% coverage: the seed URLs confirmed by hand on
25 August had rotted by mid-September (most 404), Bord Gáis serves tens of
thousands of JSON candidates none of which get attributed, and SSE/Flogas show
nothing to a static parse. None of that can be seen from the dev container —
the supplier sites are unreachable there — so this prints, from CI, exactly
what each supplier serves today: which seeds still resolve, what discovery
finds, the rate-shaped paths in any embedded JSON, and the text of any price
PDF. It writes nothing and changes nothing.

Read the output in the Actions log, then fix seeds / attribution / parsers
against what is actually there.
"""

from __future__ import annotations

import re
import sys
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from sources import (
    fetch, candidate_links, sitemap_candidates, discover,
    embedded_json, walk, _as_cents, pdf_text, RATE_RANGE,
)
from scrape_tariffs import SUPPLIERS, MAX_PAGES

WANTED = {a.lower() for a in sys.argv[1:]}
RULE = "=" * 72


def show_structured(html: str, limit: int = 40) -> None:
    blobs = embedded_json(html)
    print(f"    embedded JSON blobs: {len(blobs)}")
    if not blobs:
        return
    hits = []
    for blob in blobs:
        for path, value in walk(blob):
            c = _as_cents(value)
            if c is not None:
                hits.append((path, value, c))
    shapes: dict[str, int] = {}
    for path, _, _ in hits:
        shapes[re.sub(r"\[\d+\]|\.[0-9a-fA-F]{15,}", "[]", path)] = \
            shapes.get(re.sub(r"\[\d+\]|\.[0-9a-fA-F]{15,}", "[]", path), 0) + 1
    print(f"    rate-shaped values: {len(hits)} across {len(shapes)} path shapes")
    for shape, n in sorted(shapes.items(), key=lambda kv: -kv[1])[:limit]:
        eg = next(v for p, v, _ in hits if re.sub(r"\[\d+\]|\.[0-9a-fA-F]{15,}", "[]", p) == shape)
        print(f"      {n:>5}x  {shape}  e.g. {str(eg)[:70]!r}")


def show_plan_keywords(text: str, plans: dict) -> None:
    low = text.lower()
    for pid, kws in plans.items():
        found = [k for k in kws if k in low]
        print(f"      {'hit ' if found else 'MISS'} {pid}: {found or kws}")


def probe(spec: dict, session: requests.Session) -> None:
    print(f"\n{RULE}\n{spec['name']}  <{spec['root']}>\n{RULE}")

    print("  seeds:")
    for s in spec.get("seeds", []):
        u = urljoin(spec["root"], s)
        got = fetch(u, session=session)
        print(f"    {got.kind:10} {got.status}  {u}")

    home = fetch(spec["root"], session=session)
    print(f"  homepage: {home.kind} {home.status} {len(home.text)} bytes")
    if home.ok:
        links = candidate_links(home.text, spec["root"])
        print(f"  candidate links from homepage: {len(links)}")
        for u in links[:8]:
            print(f"    {u}")

    sm = sitemap_candidates(spec["root"], session=session)
    print(f"  sitemap candidates: {len(sm)}")
    for u in sm[:8]:
        print(f"    {u}")

    pages = discover(spec["root"], session=session, seeds=spec.get("seeds"))
    print(f"  discover() → {len(pages)} pages; reading first {MAX_PAGES}")
    for url in pages[:MAX_PAGES]:
        got = fetch(url, session=session)
        print(f"\n  --- {url}\n    {got.kind} {got.status} {len(got.content)} bytes")
        if not got.ok:
            print(f"    {got.detail}")
            continue
        if url.lower().endswith(".pdf") or got.content[:5] == b"%PDF-":
            txt = pdf_text(got.content)
            print(f"    (PDF) {len(txt)} chars")
            print("    ----- PDF TEXT (first 2500) -----")
            print(txt[:2500])
            print("    ----- END -----")
            continue
        soup = BeautifulSoup(got.text, "lxml")
        title = soup.title.get_text(strip=True) if soup.title else ""
        text = soup.get_text(" ", strip=True)
        print(f"    title: {title!r}  ·  text {len(text)} chars")
        show_structured(got.text)
        print("    plan keywords:")
        show_plan_keywords(text, spec["plans"])
        m = re.search(r"\d{1,2}[.,]\d{1,2}\s*c(?:ent)?\b", text, re.I)
        if m:
            lo, hi = max(0, m.start() - 160), min(len(text), m.end() + 160)
            print(f"    first cent figure: ...{text[lo:hi]}...")
        else:
            print("    no cent-quoted figure in the visible text")


def main() -> None:
    session = requests.Session()
    for spec in SUPPLIERS:
        if WANTED and spec["name"].lower().split()[0] not in WANTED:
            continue
        try:
            probe(spec, session)
        except Exception as e:
            print(f"  PROBE CRASHED: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
