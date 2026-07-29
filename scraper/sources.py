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
    r"unit\s*rate|standing\s*charge|price\s*list|our\s*plans)\b", re.I)

#: Words that mark a link as business, gas-only or otherwise off-target.
REJECT_WORDS = re.compile(r"\b(business|commercial|sme|gas\s*only|career|blog|news)\b", re.I)


def same_site(a: str, b: str) -> bool:
    """
    Whether two URLs belong to the same supplier.

    `www.` is the whole point. Pinergy's homepage is served from
    www.pinergy.ie and every link on it is written bare, as pinergy.ie — so a
    strict netloc comparison threw away all 194 links and the run reported
    "site reached, but no page on it looked like prices". The site was fine;
    the filter was wrong.
    """
    ha = urlparse(a).netloc.lower().removeprefix("www.")
    hb = urlparse(b).netloc.lower().removeprefix("www.")
    return ha == hb or not ha or not hb


def candidate_links(html: str, base_url: str, limit: int = 12) -> list[str]:
    """
    Links on a page that plausibly lead to residential electricity prices.

    Ranked, deduplicated and kept to the same host. Discovery is the fix for the
    actual root cause: a hardcoded '/home/electricity/plans' is guaranteed to rot
    the next time marketing reorganises the site, and it did.
    """
    soup = BeautifulSoup(html, "lxml")
    scored: dict[str, int] = {}

    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        absolute = urljoin(base_url, href)
        if not same_site(absolute, base_url):
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
             hops: int = 2) -> tuple[list[str], list[Fetched]]:
    """
    Every plausible tariff page for a supplier, best first, plus what failed.

    Two things this used to get wrong.

    It returned only URLs, so a homepage that could not be fetched at all left
    the caller with an empty list and no reason — Yuno's certificate chain
    failure was reported for weeks as "no page on it looked like prices", which
    sends whoever reads it to widen keywords that were never the problem.

    And it looked one hop from the homepage. SSE Airtricity's actual prices are
    in a "View tariff table (PDF)" linked from their current-offers page, one
    level further in. That PDF is the regulator-facing document: the steadiest
    source any of these suppliers publish, and the run never reached it.
    """
    out: list[str] = []
    failures: list[Fetched] = []

    home = fetch(root, session=session)
    if home.ok:
        out.extend(candidate_links(home.text, root))
    else:
        failures.append(home)

    for u in sitemap_candidates(root, session=session):
        if u not in out:
            out.append(u)

    # Second hop, from the best few pages found so far. PDFs score highest in
    # candidate_links, so a price list linked from a plans page rises to the top.
    if hops > 1:
        for url in list(out)[:3]:
            if url.lower().endswith(".pdf"):
                continue
            got = fetch(url, session=session)
            if not got.ok:
                failures.append(got)
                continue
            for u in candidate_links(got.text, url, limit=6):
                if u not in out and u != url:
                    out.append(u)

    # A PDF price list outranks any marketing page, wherever it was found.
    out.sort(key=lambda u: 0 if u.lower().endswith(".pdf") else 1)
    return out, failures


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
    if isinstance(value, bool):
        return None                       # bool is an int in Python; True is not 1c
    if isinstance(value, (int, float)):
        v = float(value)
    elif isinstance(value, str):
        # The number has to BE the string, give or take a currency mark or a
        # unit. Searching for the first number anywhere in the text turned a
        # five-kilobyte terms-and-conditions paragraph into a unit rate, which
        # is how Bord Gáis produced 1,984 "rate candidates" on one page.
        s = value.strip().replace(",", ".")
        m = re.fullmatch(r"[€c]?\s*(\d{1,3}(?:\.\d{1,4})?)\s*(?:c|cent|c/kWh|€)?", s, re.I)
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
            # The LAST segment has to name the value. Matching anywhere in the
            # path meant one ancestor called `tariffs` qualified every leaf
            # beneath it — chatbot opening times, IBAN lengths, a routing key
            # of 'D05' — because they all sat under a rate-ish word somewhere.
            leaf = path.lower().rsplit(".", 1)[-1]
            if not re.search(r"rate|price|unitcost|cent|standing|export|ceg", leaf):
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


#: A euro figure has to be introduced as a standing charge, or follow one within
#: a few words. Any € on the page was far too generous: on Electric Ireland's
#: plan pages it picked €120 — a cashback offer — and proposed it as a €328.58
#: standing charge, a 63% move that only the tolerance check stopped.
STANDING_CONTEXT = re.compile(
    r"standing\s*charge[^€]{0,80}€\s*(\d{2,3}(?:[.,]\d{2})?)"
    r"|€\s*(\d{2,3}(?:[.,]\d{2})?)[^€]{0,40}?standing\s*charge", re.I)


def standing_from_text(text: str) -> list[float]:
    """Annual standing charges quoted in a block of prose, named as such."""
    out = []
    for m in STANDING_CONTEXT.finditer(text):
        raw = m.group(1) or m.group(2)
        v = float(raw.replace(",", "."))
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
# The regulator-facing price list, as a table
#
# SSE Airtricity publishes its full price list as a PDF whose layout is a fixed
# table, not prose. That is exactly why it is worth parsing: a keyword-and-window
# scrape guesses, but a table has columns that mean the same thing every time.
#
# Each unit-rate row is a label, then ten numbers, then a descriptor:
#
#     24 Hour Meter Inc. Smart◊
#     37.73 41.13 26.41 28.79 29.05 31.66 31.32 34.14 33.96 37.02
#     Rate (cents/kWh)
#
# The ten numbers are five discount columns — Standard, DD & eBill, DD & Post,
# Non DD & eBill, Non DD & Post — each as an (Ex. VAT, Inc. VAT) pair. Which
# column a supplier's headline number comes from is a real decision, so it is a
# named constant rather than a magic index. See PRICE_COLUMN below.
# ---------------------------------------------------------------------------

#: The five discount columns of an SSE price table, in order.
SSE_COLUMNS = ["Standard", "DD & eBill", "DD & Post", "Non DD & eBill", "Non DD & Post"]

#: Which column, and Ex. or Inc. VAT, the stored unit rate represents.
#:
#: This is not arbitrary. The rates already in tariffs.json match "DD & Post,
#: Inc. VAT" to within ~1% (SSE-EVDAY's 31.52c against the table's 31.66c),
#: while the headline paperless "DD & eBill" column sits ~8% lower. Matching the
#: established basis keeps a fresh scrape consistent with the existing numbers
#: instead of silently re-baselining every SSE plan onto a cheaper tariff. To
#: switch to the headline rate, change this one line — nothing else moves.
PRICE_COLUMN = ("DD & Post", "inc")

#: Byte offset of the chosen value within a row's ten numbers.
_PRICE_INDEX = SSE_COLUMNS.index(PRICE_COLUMN[0]) * 2 + (1 if PRICE_COLUMN[1] == "inc" else 0)

_RATE_ROW = re.compile(r"^(?:\d{1,3}\.\d{2}\s+){9}\d{1,3}\.\d{2}$")
_STANDING_ROW = re.compile(
    r"^(.+?)\s+([\d.]+)\s+([\d.]+)\s+€\s*([\d,]+(?:\.\d{2})?)\s+€\s*([\d,]+(?:\.\d{2})?)$")


def _rate_kind(descriptor: str) -> str:
    """Which band a rate row is, from the line beneath its numbers."""
    d = descriptor.lower()
    if d.startswith("day rate"):   return "day"
    if d.startswith("night rate"): return "night"
    if d.startswith("peak rate"):  return "peak"
    if d.startswith("18h rate"):   return "18h"
    if d.startswith("6h rate"):    return "6h"
    if d.startswith("rate"):       return "flat"
    return "?"


def parse_rate_table(text: str) -> list[dict]:
    """
    Every unit-rate row in an SSE price list, as structured records.

    Each is ``{meter, kind, cents}`` where ``cents`` is the value from the
    configured column (PRICE_COLUMN). The meter is the label line above the
    numbers ('24 Hour Meter Inc. Smart', 'Smart Meter', 'Smart EV Max'); the
    kind is the band beneath them. Returns records, never a verdict — attributing
    them to our plan ids is the caller's job, and stays supplier-specific.
    """
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    out: list[dict] = []
    for i, ln in enumerate(lines):
        if not _RATE_ROW.match(ln):
            continue
        nums = [float(x) for x in ln.split()]
        meter = re.sub(r"[◊♦*]+", "", lines[i - 1]).strip() if i else ""
        kind = _rate_kind(lines[i + 1]) if i + 1 < len(lines) else "?"
        cents = nums[_PRICE_INDEX]
        if RATE_RANGE[0] <= cents <= RATE_RANGE[1]:
            out.append({"meter": meter, "kind": kind, "cents": cents})
    return out


def parse_standing_table(text: str) -> dict[str, float]:
    """
    Annual standing charges from an SSE price list, keyed by meter label.

    The euro-per-year Inc. VAT figure — the last of the four numbers on a row
    like ``Urban 24 hr 66.32 72.29 € 242.07 € 263.86``. Inc. VAT because that is
    what the stored figures already are: SSE-EVMAX's 357.23 is the table's Inc.
    VAT to the cent.
    """
    out: dict[str, float] = {}
    for ln in text.splitlines():
        m = _STANDING_ROW.match(ln.strip())
        if not m:
            continue
        label = m.group(1).strip().lower()
        inc_year = float(m.group(5).replace(",", ""))
        if STANDING_RANGE[0] <= inc_year <= STANDING_RANGE[1]:
            out[label] = round(inc_year, 2)
    return out


def parse_export_cent(text: str) -> Optional[float]:
    """The clean-export (CEG) rate a price list quotes, in euro per kWh."""
    m = re.search(r"clean export tariff of\s+(\d{1,2}(?:\.\d+)?)\s*cent", text, re.I)
    if not m:
        return None
    v = float(m.group(1))
    return round(v / 100, 4) if EXPORT_RANGE[0] <= v <= EXPORT_RANGE[1] else None


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
