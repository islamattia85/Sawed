#!/usr/bin/env python3
"""
What the supplier sites actually look like today.

This exists because the parsers cannot be fixed from a description. The live
run says "nothing recognisable" for SSE and Flogas and "no page reached" for
Yuno and Pinergy, which names the half of the job that broke but not the shape
of the thing that replaced it — and the sites are unreachable from the
development container, so the only place their markup can be seen is a runner.

So this prints, rather than parses: what discovery found, what each page turned
out to be, and — the part that matters — the structured values a page ships and
the paths they sit at. A value at `props.pageProps.plans[0].unitRate` can be
attributed to a plan with certainty. A number three hundred characters from the
words "Smart Standard" cannot, and that guess is most of why the current
coverage is 24%.

Read the output in the Actions log. It writes nothing and changes nothing.
"""

from __future__ import annotations

import json
import re
import sys
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

from sources import (
    fetch, discover, candidate_links, sitemap_candidates,
    embedded_json, walk, _as_cents,
)
from scrape_tariffs import SUPPLIERS, MAX_PAGES

#: Only these, when given as arguments — the whole sweep is long and the fix is
#: usually one supplier at a time.
WANTED = {a.lower() for a in sys.argv[1:]}

RULE = "=" * 72


def show_structured(html: str, limit: int = 60) -> None:
    """Rate-shaped leaves in a page's embedded JSON, with their paths."""
    blobs = embedded_json(html)
    print(f"    embedded JSON blobs: {len(blobs)}")
    if not blobs:
        return

    hits: list[tuple[str, object, float]] = []
    for blob in blobs:
        for path, value in walk(blob):
            cents = _as_cents(value)
            if cents is None:
                continue
            hits.append((path, value, cents))

    # The paths are what a parser keys on, so the shape of the path matters more
    # than the count. Group by the path with list indices flattened.
    shapes: dict[str, int] = {}
    for path, _, _ in hits:
        shapes[re.sub(r"\[\d+\]", "[]", path)] = shapes.get(re.sub(r"\[\d+\]", "[]", path), 0) + 1

    print(f"    rate-shaped values: {len(hits)} across {len(shapes)} distinct paths")
    for shape, n in sorted(shapes.items(), key=lambda kv: -kv[1])[:limit]:
        example = next(v for p, v, _ in hits if re.sub(r"\[\d+\]", "[]", p) == shape)
        # Truncated hard: a Redux dump carries five-kilobyte terms-and-conditions
        # paragraphs that match the rate filter, and printing them in full made
        # the first run of this file unreadable.
        print(f"      {n:>5}x  {shape}  e.g. {str(example)[:90]!r}")


def show_plan_names(text: str, plans: dict) -> None:
    """Whether our plan keywords appear on the page at all."""
    low = text.lower()
    for plan_id, keywords in plans.items():
        found = [k for k in keywords if k in low]
        mark = "hit " if found else "MISS"
        print(f"      {mark} {plan_id}: {found or keywords}")


def probe(spec: dict, session: requests.Session) -> None:
    print(f"\n{RULE}\n{spec['name']}  <{spec['root']}>\n{RULE}")

    home = fetch(spec["root"], session=session)
    print(f"  homepage: {home.kind} {home.status} {len(home.text)} bytes  {home.detail}")

    if home.ok:
        links = candidate_links(home.text, spec["root"])
        print(f"  candidate links from homepage: {len(links)}")
        for u in links[:10]:
            print(f"    {u}")
        # When discovery finds nothing, the useful question is what IS on the
        # page — a nav that renders in JavaScript leaves no <a href> to score.
        if not links:
            soup = BeautifulSoup(home.text, "lxml")
            hrefs = [a["href"] for a in soup.find_all("a", href=True)]
            print(f"    (page has {len(hrefs)} links in total; first 25 below)")
            for h in hrefs[:25]:
                print(f"      {h}")

    sm = sitemap_candidates(spec["root"], session=session)
    print(f"  sitemap candidates: {len(sm)}")
    for u in sm[:10]:
        print(f"    {u}")

    pages, discovery_failures = discover(spec["root"], session=session)
    for f in discovery_failures:
        print(f"  discovery failure: {f.url} → {f.kind}: {f.detail[:120]}")
    for url in pages[:MAX_PAGES]:
        got = fetch(url, session=session)
        print(f"\n  --- {url}")
        print(f"    {got.kind} {got.status} {len(got.content)} bytes")
        if not got.ok:
            print(f"    {got.detail}")
            continue
        if url.lower().endswith(".pdf") or got.content[:5] == b"%PDF-":
            print("    (PDF)")
            continue
        soup = BeautifulSoup(got.text, "lxml")
        title = soup.title.get_text(strip=True) if soup.title else ""
        text = soup.get_text(" ", strip=True)
        print(f"    title: {title!r}")
        print(f"    text: {len(text)} chars")
        show_structured(got.text)
        print("    plan keywords:")
        show_plan_names(text, spec["plans"])
        # A short window around the first cent-quoted number says whether the
        # prose route has anything left to work with.
        m = re.search(r"\d{1,2}[.,]\d{1,2}\s*c(?:ent)?\b", text, re.I)
        if m:
            lo, hi = max(0, m.start() - 200), min(len(text), m.end() + 200)
            print(f"    first cent figure in context: ...{text[lo:hi]}...")
        else:
            print("    no cent-quoted figure in the text at all")


def main() -> None:
    session = requests.Session()
    for spec in SUPPLIERS:
        if WANTED and spec["name"].lower().split()[0] not in WANTED:
            continue
        try:
            probe(spec, session)
        except Exception as e:                    # a probe must never end the sweep
            print(f"  PROBE CRASHED: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
