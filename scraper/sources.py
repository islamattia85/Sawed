#!/usr/bin/env python3
"""
Finding and reading supplier tariff data.

Everything here is a pure function over bytes or a string except `fetch`, so the
parsing can be tested against fixtures without touching the network — which
matters, because the previous version was only ever exercised by the live run
and spent eight weeks failing in a way nobody could see.

The design follows what the logs actually showed. Of twelve failed requests in
the 26 July run, eleven were 404 and one was a TLS chain error. Not one was a
403, a rate limit or a bot challenge. The problem was never access; it was that
the URLs were hardcoded deep links and the suppliers had reorganised their
sites. So: discover pages instead of pinning them, prefer machine-readable data
over prose, and treat "moved" as a loud failure rather than a warning.
"""

from __future__ import annotations

import io
import json
import re
import logging
from dataclasses import dataclass, field
from typing import Iterable, Optional
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

log = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; SolarOptimiserBot/1.0; "
        "+https://github.com/islamattia85/sawed)"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IE,en;q=0.9",
}


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

@dataclass
class Fetched:
    """
    The outcome of one request, with the failure mode kept distinct.

    "Could not reach it", "it has moved" and "read it fine but found nothing"
    demand completely different fixes, and the old scraper logged all three as
    the same warning. That is how a set of dead links passed for bot-blocking.
    """
    url: str
    status: Optional[int] = None
    text: str = ""
    content: bytes = b""
    kind: str = "ok"          # ok | moved | refused | unreachable | tls | nolinks
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.kind == "ok"


def fetch(url: str, timeout: int = 20, session: Optional[requests.Session] = None) -> Fetched:
    """Fetch a URL, classifying the failure rather than flattening it."""
    s = session or requests
    try:
        r = s.get(url, headers=HEADERS, timeout=timeout, allow_redirects=True)
    except requests.exceptions.SSLError as e:
        # Some Irish supplier sites serve an incomplete certificate chain.
        # Browsers recover by fetching the missing intermediate; Python does
        # not. This is a server misconfiguration, not a refusal, and it should
        # be reported as its own thing so nobody reads it as blocking.
        return Fetched(url, kind="tls", detail=str(e)[:200])
    except requests.RequestException as e:
        return Fetched(url, kind="unreachable", detail=str(e)[:200])

    if r.status_code in (401, 403, 429):
        return Fetched(url, status=r.status_code, kind="refused",
                       detail=f"HTTP {r.status_code}")
    if r.status_code == 404 or r.status_code == 410:
        return Fetched(url, status=r.status_code, kind="moved",
                       detail=f"HTTP {r.status_code} — the page has moved or been removed")
    if r.status_code >= 400:
        return Fetched(url, status=r.status_code, kind="unreachable",
                       detail=f"HTTP {r.status_code}")

    return Fetched(url, status=r.status_code, text=r.text, content=r.content, kind="ok")


# ---------------------------------------------------------------------------
# Discovery — find the tariff page instead of pinning it
# ---------------------------------------------------------------------------

#: Words that mark a link as likely to lead to prices.
PRICE_WORDS = re.compile(
    r"\b(price|prices|pricing|tariff|tariffs|rate|rates|plan|plans|"
    r"unit\s*rate|standing\s*charge|price\s*list|our\s*plans|"
    # Path shapes the Irish suppliers actually ship. Hyphens are word
    # boundaries to \b, so "ev-plan-comparison" already matches on "plan" —
    # these are here for the ones that do not mention a price word at all.
    r"smart\s*meters?|our\s*tariffs|price\s*plans|ev\s*plan\s*comparison)\b",
    re.I)

#: Words that mark a link as business, gas-only or otherwise off-target.
REJECT_WORDS = re.compile(r"\b(business|commercial|sme|gas\s*only|career|blog|news)\b", re.I)


def candidate_links(html: str, base_url: str, limit: int = 12) -> list[str]:
    """
    Links on a page that plausibly lead to residential electricity prices.

    Ranked, deduplicated and kept to the same host. Discovery is the fix for the
    actual root cause: a hardcoded '/home/electricity/plans' is guaranteed to rot
    the next time marketing reorganises the site, and it did.
    """
    soup = BeautifulSoup(html, "lxml")
    host = urlparse(base_url).netloc
    scored: dict[str, int] = {}

    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        absolute = urljoin(base_url, href)
        if urlparse(absolute).netloc not in (host, ""):
            continue

        label = " ".join(a.get_text(" ", strip=True).split())[:120]
        haystack = f"{label} {urlparse(absolute).path}"
        if REJECT_WORDS.search(haystack):
            continue
        hits = len(PRICE_WORDS.findall(haystack))
        if not hits:
            continue

        score = hits
        # A path segment is a stronger signal than link text, which is often
        # navigation furniture repeated across the site.
        if PRICE_WORDS.search(urlparse(absolute).path):
            score += 2
        if re.search(r"\b(price\s*list|standing\s*charge|unit\s*rate)\b", haystack, re.I):
            score += 2
        if absolute.lower().endswith(".pdf"):
            score += 3          # the regulator-facing document; most stable of all
        scored[absolute.split("#")[0]] = max(score, scored.get(absolute.split("#")[0], 0))

    return [u for u, _ in sorted(scored.items(), key=lambda kv: -kv[1])][:limit]


def sitemap_candidates(root: str, session: Optional[requests.Session] = None,
                       limit: int = 12) -> list[str]:
    """Price-looking URLs from a sitemap, for sites whose nav is script-rendered."""
    got = fetch(urljoin(root, "/sitemap.xml"), session=session)
    if not got.ok:
        return []
    urls = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", got.text)
    hits = [u for u in urls if PRICE_WORDS.search(urlparse(u).path)
            and not REJECT_WORDS.search(u)]
    return hits[:limit]


def discover(root: str, session: Optional[requests.Session] = None,
             seeds: Optional[Iterable[str]] = None) -> list[str]:
    """
    Every plausible tariff page for a supplier, best first.

    Seeds come first, and they exist because pure discovery has a blind spot
    that cost this scraper a month. On 25 August 2026 every one of the seven
    supplier homepages answered 200 and yielded no candidate links at all —
    seven `nolinks` in a row. The sites are not blocking anything; their
    navigation is rendered by script, so a static parse sees a shell with no
    anchors in it. Discovery cannot find a link that is not in the HTML.

    A seed is a URL confirmed by hand to serve prices today. It is deliberately
    NOT the old hardcoded deep link in a new coat: discovery still runs, seeds
    are only tried first, and a seed that 404s is reported as `moved` like any
    other broken link, so rot is loud instead of silent. The failure mode this
    guards against is the one that actually happened, not the one that was
    feared.
    """
    out: list[str] = []
    for u in (seeds or []):
        absolute = urljoin(root, u)
        if absolute not in out:
            out.append(absolute)
    home = fetch(root, session=session)
    if home.ok:
        for u in candidate_links(home.text, root):
            if u not in out:
                out.append(u)
    for u in sitemap_candidates(root, session=session):
        if u not in out:
            out.append(u)
    return out


# ---------------------------------------------------------------------------
# Extraction — machine-readable first, prose last
# ---------------------------------------------------------------------------

def embedded_json(html: str) -> list[dict]:
    """
    Structured data a page ships alongside its markup.

    Modern sites hand the browser the same numbers as JSON — Next.js in
    __NEXT_DATA__, Nuxt in window.__NUXT__, and schema.org in ld+json. Reading
    that is far steadier than finding a keyword and regexing the six hundred
    characters around it, which is what the old parsers did and why a single
    layout change silenced them.
    """
    found: list[dict] = []
    soup = BeautifulSoup(html, "lxml")

    for tag in soup.find_all("script", {"type": "application/ld+json"}):
        try:
            data = json.loads(tag.string or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        found.extend(data if isinstance(data, list) else [data])

    for tag in soup.find_all("script", id=re.compile(r"__NEXT_DATA__|__NUXT_DATA__")):
        try:
            found.append(json.loads(tag.string or "{}"))
        except (json.JSONDecodeError, TypeError):
            continue

    m = re.search(r"window\.__(?:NUXT|INITIAL_STATE)__\s*=\s*(\{.*?\});?\s*</script>",
                  html, re.S)
    if m:
        try:
            found.append(json.loads(m.group(1)))
        except json.JSONDecodeError:
            pass
    return found


def walk(node, path: str = "") -> Iterable[tuple[str, object]]:
    """Every leaf in a nested structure, with a dotted path to it."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield from walk(v, f"{path}.{k}" if path else str(k))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk(v, f"{path}[{i}]")
    else:
        yield path, node


#: A unit rate in cent per kWh. Irish residential rates sit well inside this.
RATE_RANGE = (5.0, 80.0)
#: An annual standing charge in euro.
STANDING_RANGE = (100.0, 700.0)
#: A microgeneration export payment in cent per kWh.
EXPORT_RANGE = (5.0, 30.0)


def _as_cents(value) -> Optional[float]:
    """A number that could be a cent-per-kWh rate, however it was written."""
    if isinstance(value, (int, float)):
        v = float(value)
    elif isinstance(value, str):
        m = re.search(r"(\d{1,3}(?:[.,]\d{1,4})?)", value.replace(",", "."))
        if not m:
            return None
        v = float(m.group(1))
    else:
        return None
    # Some feeds quote euro per kWh (0.3245) rather than cent (32.45).
    if 0.05 <= v <= 0.80:
        v *= 100
    return v if RATE_RANGE[0] <= v <= RATE_RANGE[1] else None


def rates_from_json(blobs: list[dict]) -> dict[str, float]:
    """
    Rate-shaped values keyed by the path they were found at.

    Deliberately returns candidates rather than a verdict: a human reviews the
    diff, and a wrong number that reaches a recommendation is far worse than a
    missing one.
    """
    out: dict[str, float] = {}
    for blob in blobs:
        for path, value in walk(blob):
            key = path.lower()
            if not re.search(r"rate|price|tariff|unit|cent|charge|standing|export|ceg", key):
                continue
            cents = _as_cents(value)
            if cents is None:
                continue
            out[path] = round(cents / 100, 4)
    return out


def rates_from_text(text: str) -> list[float]:
    """Every plausible unit rate in a block of prose, as euro per kWh."""
    out = []
    for m in re.finditer(r"(\d{1,2}[.,]\d{1,2})\s*c(?:ent)?\b", text, re.I):
        v = float(m.group(1).replace(",", "."))
        if RATE_RANGE[0] <= v <= RATE_RANGE[1]:
            out.append(round(v / 100, 4))
    return out


def standing_from_text(text: str) -> list[float]:
    """Annual standing charges quoted in a block of prose."""
    out = []
    for m in re.finditer(r"€\s*(\d{2,3}(?:[.,]\d{2})?)", text):
        v = float(m.group(1).replace(",", "."))
        if STANDING_RANGE[0] <= v <= STANDING_RANGE[1]:
            out.append(round(v, 2))
    return out


def pdf_text(data: bytes) -> str:
    """
    Text of a price-list PDF.

    Irish suppliers publish a standard price list as a PDF — the document the
    regulator sees — at URLs that change far less often than marketing pages,
    with a layout that changes less often still. pdfplumber has been in
    requirements.txt since the beginning without ever being called.
    """
    try:
        import pdfplumber
    except Exception as e:
        # Not just ImportError: pdfplumber pulls in cryptography's Rust
        # bindings, which raise a panic rather than an ImportError when the
        # wheel does not match the interpreter. A price list we cannot open is
        # a missing source, never a dead run.
        log.warning(f"pdfplumber unavailable ({e}); skipping PDF price lists")
        return ""
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            return "\n".join((page.extract_text() or "") for page in pdf.pages)
    except Exception as e:                      # a malformed PDF must not stop the run
        log.warning(f"could not read PDF: {e}")
        return ""


# ---------------------------------------------------------------------------
# Per-supplier result
# ---------------------------------------------------------------------------

@dataclass
class SupplierResult:
    """What one supplier yielded, and why if it yielded nothing."""
    supplier: str
    pages_tried: list[str] = field(default_factory=list)
    failures: list[Fetched] = field(default_factory=list)
    rates: dict[str, float] = field(default_factory=dict)
    standing: list[float] = field(default_factory=list)
    reached_a_page: bool = False

    def summary(self) -> str:
        if self.rates or self.standing:
            return f"{self.supplier}: {len(self.rates)} rate candidate(s), {len(self.standing)} standing"
        if not self.reached_a_page:
            kinds = ", ".join(sorted({f.kind for f in self.failures})) or "no pages found"
            return f"{self.supplier}: NO PAGE REACHED ({kinds})"
        return f"{self.supplier}: pages read, nothing recognisable — the parser needs updating"
