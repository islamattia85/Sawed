#!/usr/bin/env python3
"""
The daily gas check, for dual-fuel homes.

Reads each gas supplier's own price page in a real browser, takes out the
figures the app uses (src/gas-tariffs.json) and compares them:

  * a figure changed       -> the JSON is updated; the workflow opens a pull
                              request for a person to review
  * a page can't be read   -> reported UNREADABLE; the workflow raises an issue

    python gas_check.py              # read and report (gas_report.md)
    python gas_check.py --apply      # also write changes to src/gas-tariffs.json

Parsers are small and literal on purpose: each looks for the words the
supplier prints next to the number. When a supplier redesigns its page the
parser returns nothing, and that is reported, never guessed around.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "src" / "gas-tariffs.json"
VAT = 1.09
CARBON = 0.0125132          # € per kWh incl. VAT (Bord Gáis tariff page)
TYPICAL_KWH = 11000         # CRU's estimated-annual-bill home

PAGES = {
    "Bord Gáis Energy": ["https://www.bordgaisenergy.ie/home/our-tariffs",
                         "https://www.bordgaisenergy.ie/home/compare-dual-fuel-price-plans",
                         "https://www.bordgaisenergy.ie/home/compare-gas-price-plans"],
    "Electric Ireland": ["https://www.electricireland.ie/residential/electricity-and-gas/gas-price-plans",
                         "https://www.electricireland.ie/residential/electricity-and-gas/dual-fuel-price-plans"],
    "Energia": ["https://www.energia.ie/about-energia/our-tariffs", "https://www.energia.ie/energy-plans/gas"],
    "SSE Airtricity": ["https://www.sseairtricity.com/ie/home/products/gas/"],
    "Flogas": ["https://www.flogas.ie/price-plans/"],
}

NUM = r"(\d+(?:[.,]\d+)?)"


def _f(s: str) -> float:
    return float(s.replace(",", ""))


def _after(lines: list[str], i: int, pat: str, within: int = 12):
    """The first match of `pat` in the `within` lines after line i."""
    for ln in lines[i + 1:i + 1 + within]:
        m = re.search(pat, ln, re.I)
        if m:
            return m
    return None


def _find(lines: list[str], pat: str, start: int = 0) -> int:
    for n in range(start, len(lines)):
        if re.search(pat, lines[n], re.I):
            return n
    return -1


# ------------------------------------------------------------------ parsers
# Each takes {url: [lines]} and returns the fields it could read.

def parse_bord_gais(pages: dict[str, list[str]]) -> dict:
    out: dict = {}
    t = pages.get(PAGES["Bord Gáis Energy"][0], [])

    def block(heading: str):
        i = _find(t, heading)
        if i < 0:
            return None
        vals = [_f(m.group(1)) for ln in t[i:i + 25] for m in [re.match(NUM + r"\s*Inc VAT", ln)] if m]
        # Standing charge first, then the unit rate (cents).
        return (vals[0], vals[1] / 100) if len(vals) >= 2 else None

    cur = block(r"^Current residential gas tariffs")
    if cur:
        out["standing"], out["unit"] = round(cur[0], 2), round(cur[1], 5)
    up = block(r"^Upcoming residential gas tariffs")
    if up and cur:
        i = _find(t, r"^Upcoming residential gas tariffs")
        m = _after(t, i, r"Effective from (\d{1,2} \w+ \d{4})", 3)
        if m:
            eff = dt.datetime.strptime(m.group(1), "%d %B %Y").date().isoformat()
            out["price_change"] = {"effective_date": eff, "pct": round(up[1] / cur[1] - 1, 4),
                                   "standing_pct": round(up[0] / cur[0] - 1, 4),
                                   "note": f"Gas {cur[1]*100:.2f}c → {up[1]*100:.2f}c, standing €{cur[0]:.2f} → €{up[0]:.2f} from {m.group(1)}."}
    elif cur:
        out["price_change"] = None
    d = pages.get(PAGES["Bord Gáis Energy"][1], [])
    i = _find(d, r"^Gas discount$")
    m = _after(d, i, r"^(\d{1,2})%$", 3) if i >= 0 else None
    if m:
        out["dual_discount"] = int(m.group(1)) / 100
    g = pages.get(PAGES["Bord Gáis Energy"][2], [])
    i = _find(g, r"Get (\d{1,2})% off gas")
    if i >= 0:
        out["gas_discount"] = int(re.search(r"(\d{1,2})%", g[i]).group(1)) / 100
    return out


def parse_electric_ireland(pages: dict[str, list[str]]) -> dict:
    out: dict = {}
    g = pages.get(PAGES["Electric Ireland"][0], [])
    i = _find(g, r"(\d{1,2})% discount on gas unit rates")
    j = _find(g, r"Gas unit price\s+" + NUM + r"c per kWh")
    if i >= 0 and j >= 0:
        disc = int(re.search(r"(\d{1,2})%", g[i]).group(1)) / 100
        price = _f(re.search(NUM + r"c per kWh", g[j]).group(1)) / 100
        out["gas_discount"] = disc
        out["unit"] = round(price / (1 - disc), 5)
        k = _find(g, r"^Estimated Annual Bill \(EAB\)")
        m = _after(g, k, r"^€\s*" + NUM + "$", 3) if k >= 0 else None
        if m:
            out["standing"] = round(_f(m.group(1)) - TYPICAL_KWH * (price + CARBON), 2)
    d = pages.get(PAGES["Electric Ireland"][1], [])
    i = _find(d, r"(\d{1,2})% discount on electricity and gas unit rates")
    if i >= 0:
        out["dual_discount"] = int(re.search(r"(\d{1,2})%", d[i]).group(1)) / 100
    return out


def parse_energia(pages: dict[str, list[str]]) -> dict:
    out: dict = {}
    t = pages.get(PAGES["Energia"][0], [])
    for ln in t:
        m = re.match(r"^Gas\s+Gas\s+Gas\s+" + NUM + "$", ln)
        if m:
            out["unit"] = round(_f(m.group(1)) * VAT / 100, 5)
        m = re.match(r"^Gas\s+Gas\s+€\s*" + NUM + "$", ln)
        if m:
            out["standing"] = round(_f(m.group(1)) * VAT, 2)
    g = pages.get(PAGES["Energia"][1], [])
    i = _find(g, r"(\d{1,2})% Discount on our standard gas rate")
    if i >= 0:
        out["gas_discount"] = int(re.search(r"(\d{1,2})%", g[i]).group(1)) / 100
    return out


def parse_sse(pages: dict[str, list[str]]) -> dict:
    out: dict = {}
    t = pages.get(PAGES["SSE Airtricity"][0], [])
    i = _find(t, r"^Discounted rate (\d{1,2})%")
    j = _find(t, r"^Cent per kWh$", max(i, 0))
    if i >= 0 and j >= 0:
        nums = [_f(x) for x in t[j + 1:j + 3] if re.fullmatch(NUM, x)]
        if len(nums) == 2:
            out["unit"] = round(max(nums) / 100, 5)
            out["gas_discount"] = int(re.search(r"(\d{1,2})%", t[i]).group(1)) / 100
    k = _find(t, r"^€ per year$")
    m = _after(t, k, r"^€\s*" + NUM + "$", 8) if k >= 0 else None
    if m:
        out["standing"] = _f(m.group(1))
    return out


def parse_flogas(pages: dict[str, list[str]]) -> dict:
    out: dict = {}
    t = pages.get(PAGES["Flogas"][0], [])
    i = _find(t, r"Dual Fuel (\d{1,2})% (Loyalty )?Discount")
    if i < 0:
        return out
    disc = int(re.search(r"(\d{1,2})%", t[i]).group(1)) / 100
    u = _find(t, r"^Gas Unit Rate$", i)
    s = _find(t, r"^Gas Standing Charge$", i)
    mu = _after(t, u, r"^" + NUM + "$", 3) if u >= 0 else None
    ms = _after(t, s, r"^€\s*" + NUM + "$", 3) if s >= 0 else None
    if mu and ms:
        out["dual_discount"] = disc
        out["unit"] = round(_f(mu.group(1)) / 100 / (1 - disc), 5)
        out["standing"] = _f(ms.group(1))
    return out


PARSERS = {
    "Bord Gáis Energy": parse_bord_gais,
    "Electric Ireland": parse_electric_ireland,
    "Energia": parse_energia,
    "SSE Airtricity": parse_sse,
    "Flogas": parse_flogas,
}
# A supplier must yield these, or it is UNREADABLE.
REQUIRED = ("unit", "standing")
# Changes smaller than this are rounding, not a new price.
TOL = {"unit": 0.00005, "standing": 0.06, "gas_discount": 0.0001, "dual_discount": 0.0001}


def compare(current: list[dict], read: dict[str, dict]) -> tuple[list[dict], list[str], bool]:
    """New data, report lines, and whether everything was readable."""
    today = dt.date.today().isoformat()
    new, lines, clean = [], [], True
    for g in current:
        got = read.get(g["supplier"]) or {}
        if not all(k in got for k in REQUIRED):
            clean = False
            lines.append(f"- **{g['supplier']}**: UNREADABLE — kept {g['unit']*100:.2f}c, €{g['standing']:.2f} from {g['verified_date']}.")
            new.append(g)
            continue
        h = dict(g)
        changes = []
        for k, tol in TOL.items():
            if k in got and got[k] is not None and (g.get(k) is None or abs(got[k] - g[k]) > tol):
                changes.append(f"{k} {g.get(k)} → {got[k]}")
                h[k] = got[k]
        if "price_change" in got and got["price_change"] != g.get("price_change"):
            if got["price_change"] is None:
                h.pop("price_change", None)
                changes.append("announced rise now in effect")
            else:
                h["price_change"] = got["price_change"]
                changes.append(f"announced change: {got['price_change']['note']}")
        h["verified_date"] = today
        lines.append(f"- **{g['supplier']}**: " + ("; ".join(c.rstrip(".") for c in changes) if changes else "unchanged") + ".")
        new.append(h)
    return new, lines, clean


def render(urls: list[str]) -> dict[str, list[str]]:
    from playwright.sync_api import sync_playwright
    opener = re.compile(r"(gas|dual fuel|tariff rates|show more|unit rates)", re.I)
    out: dict[str, list[str]] = {}
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = b.new_page(user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36")
        for u in urls:
            try:
                page.goto(u, wait_until="networkidle", timeout=60000)
                page.wait_for_timeout(2000)
                for sel in ["button", "[role=tab]", "summary"]:
                    for el in page.query_selector_all(sel)[:80]:
                        try:
                            t = (el.inner_text() or "").strip()
                            if t and len(t) < 60 and opener.search(t):
                                el.click(timeout=1500); page.wait_for_timeout(300)
                        except Exception:
                            pass
                out[u] = [ln.strip() for ln in page.inner_text("body").splitlines() if ln.strip()]
            except Exception as e:  # noqa: BLE001 — reported as unreadable
                print(f"  {u}: {str(e)[:120]}")
                out[u] = []
        b.close()
    return out


def main() -> int:
    current = json.loads(DATA.read_text(encoding="utf-8"))
    read = {}
    for sup, urls in PAGES.items():
        pages = render(urls)
        try:
            read[sup] = PARSERS[sup](pages)
        except Exception as e:  # noqa: BLE001
            print(f"{sup}: parser error {e}")
            read[sup] = {}
        print(sup, read[sup])
    new, lines, clean = compare(current, read)
    report = "## Gas prices (dual-fuel homes)\n\n" + "\n".join(lines) + "\n"
    Path("gas_report.md").write_text(report, encoding="utf-8")
    print(report)
    if "--apply" in sys.argv:
        DATA.write_text(json.dumps(new, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0 if clean else 1


if __name__ == "__main__":
    sys.exit(main())
