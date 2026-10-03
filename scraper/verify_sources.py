#!/usr/bin/env python3
"""
Re-read every plan in the registry from the supplier's own published page.

Each plan in public/tariffs.json carries a `source` recipe: the page its prices
come from, the heading its price table sits under, and the label of every
figure. This script opens the captured evidence (scraper/audit_dump.py writes
one JSON per supplier), follows each recipe, and compares what the supplier
publishes today with what the registry holds.

    python scraper/verify_sources.py EVIDENCE_DIR            # report only
    python scraper/verify_sources.py EVIDENCE_DIR --apply    # also write changes

A plan whose recipe can no longer be followed (page gone, label renamed) is
reported as UNREADABLE, never silently kept as verified. The report is written
to verify_report.md and the exit status is 1 when anything changed or could not
be read, so a scheduled run surfaces it.

Recipe shape (all rates in the page are c/kWh inc VAT, standing €/yr inc VAT):

    "source": {
      "url": "https://www.yunoenergy.ie/",       # the evidence page
      "anchor": ["EV Variable Smart", "DNP Urban"],  # headings, found in order
      "fields": {                                # registry field -> page label
        "day": "Day Unit Rate", "night": "Night Unit Rate",
        "standing": "Urban Standing Charge"
      },
      "col": 2,          # which number after the label (Yuno: ex VAT, then inc)
      "vat": 1.09        # optional: page figure is ex VAT, multiply
    }

A field may list several labels whose figures are summed (a prepay standing
charge plus its service charge). `weekend.<band>` fields write into the plan's
weekend rates. Flogas publishes through an API rather than a page; its recipes
say `"api": "flogas"` and name the plan and row labels instead.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARIFFS = ROOT / "public" / "tariffs.json"
MAIN_JS = ROOT / "src" / "main.js"

# Prices always carry decimals (34.85c, €219.22); whole numbers on these pages
# are times and counts ("8am to 11pm", "12 months"), never prices.
NUM = re.compile(r"(?<![\d.])(\d{1,4}(?:,\d{3})*\.\d+)")
TOLERANCE = 0.00005   # half a hundredth of a cent, in euro


def norm_url(u: str) -> str:
    return re.sub(r"^https?://(www\.)?", "", u or "").rstrip("/").lower()


def load_evidence(folder: Path) -> dict[str, dict]:
    """Every captured page, by normalised URL (requested and final)."""
    pages: dict[str, dict] = {}
    for f in sorted(folder.glob("*.json")):
        try:
            d = json.loads(f.read_text())
        except Exception:
            continue
        for p in d.get("pages", []):
            for key in (p.get("url"), p.get("final_url")):
                if key:
                    pages.setdefault(norm_url(key), p)
    return pages


def numbers_after(lines: list[str], start: int, label: str) -> tuple[int, list[float]] | None:
    """Index of the first line at/after `start` containing `label`, and the
    numbers that follow it (on that line after the label, then later lines)."""
    lab = label.lower()
    for i in range(start, len(lines)):
        if lab in lines[i].lower():
            rest = lines[i][lines[i].lower().index(lab) + len(lab):]
            nums = [float(m.replace(",", "")) for m in NUM.findall(rest)]
            j = i + 1
            while len(nums) < 6 and j < len(lines) and j < i + 14:
                # stop at the next labelled row: a line with letters and no digits
                if re.search(r"[A-Za-z]{3}", lines[j]) and not NUM.search(lines[j]):
                    if nums:
                        break
                nums += [float(m.replace(",", "")) for m in NUM.findall(lines[j])]
                j += 1
            return i, nums
    return None


def read_page_recipe(src: dict, pages: dict[str, dict]) -> dict:
    page = pages.get(norm_url(src["url"]))
    if not page:
        return {"error": f"page not captured: {src['url']}"}
    lines = [ln.strip() for ln in page.get("text", "").splitlines() if ln.strip()]
    pos = 0
    for a in src.get("anchor", []):
        hit = next((i for i in range(pos, len(lines)) if a.lower() in lines[i].lower()), None)
        if hit is None:
            return {"error": f"heading not found: {a!r}"}
        pos = hit + 1
    col = int(src.get("col", 1))
    vat = float(src.get("vat", 1.0))
    out: dict[str, float] = {}
    for field, spec in src["fields"].items():
        # A label, a list of labels to sum, or {"label": ..., "col": n} when
        # one row holds several figures ("16.91c night, 30.75c day").
        fcol = col
        if isinstance(spec, dict):
            fcol = int(spec.get("col", col))
            spec = spec["label"]
        labels = [spec] if isinstance(spec, str) else spec
        total = 0.0
        for label in labels:
            found = numbers_after(lines, pos, label)
            if not found or len(found[1]) < fcol:
                return {"error": f"{field}: label {label!r} not found or has no figure"}
            total += found[1][fcol - 1]
        if field == "standing":
            out[field] = round(total * vat, 2)
        else:
            # Most pages print c/kWh; a few (Waterpower) print €/kWh.
            per = 1 if src.get("unit") == "eur" else 100
            out[field] = round(total * vat / per, 4)
    return {"values": out}


def read_flogas(src: dict, pages: dict[str, dict]) -> dict:
    """Flogas's pricing API: plan name -> electricity rows -> inc VAT price,
    preferring a dated price that has started over the undated one."""
    today = date.today().isoformat()
    for p in pages.values():
        for j in p.get("json", []):
            if "pricing-plans" not in j.get("url", ""):
                continue
            try:
                body = json.loads(j["body"])
            except Exception:
                continue
            for plan in body.get("value", []):
                if plan.get("name", "").strip().lower() != src["plan"].strip().lower():
                    continue
                rows = {}
                for block in plan.get("pricing", []):
                    if block.get("resource") not in ("electricity", None) and "lectric" not in block.get("label", ""):
                        continue
                    for t in block.get("tables", []):
                        for r in t.get("rows", []):
                            for it in r.get("items", []):
                                price = it.get("incVATPrice")
                                for dt in it.get("dates", []) or []:
                                    if (dt.get("startDateTime") or "")[:10] <= today and dt.get("incVATPrice") is not None:
                                        price = dt["incVATPrice"]
                                # First occurrence wins: urban is listed before
                                # rural, and a 24hr table before a day/night one.
                                key = " ".join(r.get("label", "").split()).lower()
                                if price is not None and key not in rows:
                                    rows[key] = float(price)
                out = {}
                for field, label in src["fields"].items():
                    key = next((k for k in rows if label.lower() in k), None)
                    if key is None:
                        return {"error": f"{field}: row {label!r} not in Flogas plan {src['plan']!r}"}
                    out[field] = round(rows[key], 2) if field == "standing" else round(rows[key] / 100, 4)
                return {"values": out}
    return {"error": f"Flogas plan not in captured API data: {src['plan']!r}"}


CREDIT = re.compile(r"€\s?(\d{1,4})\s*(?:Welcome|Switching|Sign[- ]?up)?\s*(?:Bonus|Credit)", re.I)


def read_welcome(rec: dict, pages: dict[str, dict]) -> dict:
    """A plan's one-off credit for new customers, in euro: the first "€N
    Welcome Bonus/Credit" after the plan's heading, within a few lines (or,
    with "in": "html", within the page code, for offers the page draws from
    script). A heading found with no credit after it means the offer ended: 0."""
    page = pages.get(norm_url(rec["url"]))
    if not page:
        return {"error": f"welcome: page not captured: {rec['url']}"}
    if rec.get("in") == "html":
        html = page.get("html") or ""
        pos = 0
        for a in rec.get("anchor", []):
            i = html.find(a, pos)
            if i < 0:
                return {"value": 0.0}
            pos = i + len(a)
        m = CREDIT.search(html[pos:pos + int(rec.get("chars", 200))])
        return {"value": float(m.group(1)) if m else 0.0}
    lines = [ln.strip() for ln in page.get("text", "").splitlines() if ln.strip()]
    pos = 0
    for a in rec.get("anchor", []):
        hit = next((i for i in range(pos, len(lines)) if a.lower() in lines[i].lower()), None)
        if hit is None:
            return {"value": 0.0}
        pos = hit + 1
    for ln in lines[pos:pos + int(rec.get("within", 6))]:
        m = CREDIT.search(ln)
        if m:
            return {"value": float(m.group(1))}
    return {"value": 0.0}


def read_recipe(src: dict, pages: dict[str, dict]) -> dict:
    if src.get("api") == "flogas":
        return read_flogas(src, pages)
    return read_page_recipe(src, pages)


# Where each supplier lists its new-customer electricity plans, and how a plan
# name looks there. A name found here that no recipe reads is a plan the
# registry is missing — a supplier launching something new is caught the day
# it appears, not when a user notices.
LISTINGS = [
    ("Electric Ireland", "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E",
     # the line before "Discount on unit rates" is the plan name
     lambda lines: [lines[i - 1] for i, l in enumerate(lines) if l == "Discount on unit rates" and i]),
    ("Bord Gáis Energy", "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true",
     lambda lines: [l for l in lines if re.search(r"Electricity( Discount)?$", l) and len(l) < 60 and not l.startswith(("Discounted", "Electricity"))]),
    ("Energia", "https://www.energia.ie/energy-plans/electricity",
     # the plan table runs Plan | Best for | Meter type
     lambda lines: [lines[i - 2] for i, l in enumerate(lines) if i > 1 and re.match(r"(Smart meter|Standard 24hr meter)$", l)]),
]


def flogas_listing(pages: dict[str, dict]) -> list[str]:
    names = set()
    for p in pages.values():
        for j in p.get("json", []):
            if "pricing-plans" not in j.get("url", ""):
                continue
            try:
                body = json.loads(j["body"])
            except Exception:
                continue
            for v in body.get("value", []):
                cat = (v.get("price_category") or {}).get("name", "")
                if cat == "Electricity" and v.get("switchPlanAvailability") in ("New customer", "Both"):
                    names.add(v["name"].strip())
    return sorted(names)


def coverage(tariffs: list, pages: dict[str, dict]) -> list[str]:
    """Plan names a supplier lists that no plan in the registry reads."""
    known = set()
    for t in tariffs:
        src = t.get("source") or {}
        # `also` names the same offer listed a second time under another name.
        for a in list(src.get("anchor") or []) + [src.get("plan", "")] + list(src.get("also") or []):
            if a:
                known.add(a.strip().lower())
    missing = []
    for supplier, url, pick in LISTINGS:
        page = pages.get(norm_url(url))
        if not page:
            missing.append(f"| {supplier} | listing page not captured | {url} |")
            continue
        lines = [ln.strip() for ln in page.get("text", "").splitlines() if ln.strip()]
        for name in dict.fromkeys(pick(lines)):
            if name.strip().lower() not in known:
                missing.append(f"| {supplier} | NOT IN REGISTRY | {name} |")
    for name in flogas_listing(pages):
        if name.lower() not in known:
            missing.append(f"| Flogas | NOT IN REGISTRY | {name} |")
    return missing


def current(plan: dict, field: str):
    if field.startswith("weekend."):
        return ((plan.get("weekend") or {}).get("rates") or {}).get(field.split(".", 1)[1])
    if field in ("standing", "export_rate", "welcome_credit"):
        return plan.get(field, 0 if field == "welcome_credit" else None)
    return plan.get("rates", {}).get(field)


def assign(plan: dict, field: str, value: float) -> None:
    if field.startswith("weekend."):
        plan.setdefault("weekend", {}).setdefault("rates", {})[field.split(".", 1)[1]] = value
    elif field in ("standing", "export_rate", "welcome_credit"):
        plan[field] = value
    else:
        plan.setdefault("rates", {})[field] = value
        # A flat plan's other bands are the same number.
        if plan.get("type") == "flat" and field == "day":
            for b in ("night", "peak", "ev"):
                if b in plan["rates"]:
                    plan["rates"][b] = value


def fill_unused_bands(plan: dict) -> None:
    """A band with no window never applies; keep it equal to the rate that does
    in those hours, so no rate card or minimum ever reads a stale number."""
    r, w = plan.get("rates", {}), plan.get("windows") or {}
    for b in ("night", "peak", "ev", "wfh"):
        if b in r and not w.get(b):
            r[b] = r["night"] if (b == "ev" and w.get("night")) else r.get("day")


def write_embedded(tariffs: list) -> None:
    """Mirror the registry into the bundle's fallback copy, whole."""
    text = MAIN_JS.read_text()
    start = text.index("const EMBEDDED_TARIFFS = [")
    open_ = text.index("[", start)
    depth, end = 0, open_
    for i in range(open_, len(text)):
        if text[i] == "[":
            depth += 1
        elif text[i] == "]":
            depth -= 1
            if depth == 0:
                end = i
                break
    plans = [t for t in tariffs if t.get("id") != "__meta__"]
    body = ",\n".join("  " + json.dumps(p, ensure_ascii=False) for p in plans)
    text = text[:open_] + "[\n" + body + "\n]" + text[end + 1:]
    MAIN_JS.write_text(text)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    evidence = Path(argv[1])
    apply = "--apply" in argv
    pages = load_evidence(evidence)
    tariffs = json.loads(TARIFFS.read_text())
    today = date.today().isoformat()

    rows, changed, unreadable, no_recipe = [], 0, 0, []
    for plan in tariffs:
        if plan.get("id") == "__meta__" or plan.get("discontinued"):
            continue
        src = plan.get("source")
        if not src or not (src.get("fields") or src.get("api")):
            no_recipe.append(plan["id"])
            continue
        res = read_recipe(src, pages)
        if "error" in res:
            unreadable += 1
            rows.append(f"| {plan['id']} | UNREADABLE | {res['error']} |")
            continue
        vals = dict(res["values"])
        # Weekend bands that simply take another band's weekday rate
        # (Bord Gáis: no peak at weekends, so peak is charged at the day rate).
        for band, like in ((plan.get("weekend") or {}).get("same_as") or {}).items():
            src_val = vals.get(like, current(plan, like))
            if src_val is not None:
                vals[f"weekend.{band}"] = src_val
        welcome = src.get("welcome")
        if welcome:
            w = read_welcome(welcome, pages)
            if "error" in w:
                unreadable += 1
                rows.append(f"| {plan['id']} | UNREADABLE | {w['error']} |")
                continue
            vals["welcome_credit"] = w["value"]
        diffs = []
        for field, val in vals.items():
            old = current(plan, field)
            if old is None or abs(float(old) - val) > (0.005 if field in ("standing", "welcome_credit") else TOLERANCE):
                diffs.append(f"{field} {old} → {val}")
                if apply:
                    assign(plan, field, val)
        if diffs:
            changed += 1
            rows.append(f"| {plan['id']} | CHANGED | {'; '.join(diffs)} |")
        else:
            rows.append(f"| {plan['id']} | MATCH | all {len(vals)} figures |")
        if apply:
            plan["verified_date"] = today
            plan.setdefault("source", {})["read"] = today

    report = [f"# Registry check against supplier pages — {today}", "",
              f"{sum(1 for r in rows if 'MATCH' in r)} match, {changed} changed, "
              f"{unreadable} unreadable, {len(no_recipe)} without a recipe.", "",
              "| Plan | Result | Detail |", "|---|---|---|", *rows]
    if no_recipe:
        report += ["", "Plans with no recipe (checked by hand only): " + ", ".join(no_recipe)]
    gaps = coverage(tariffs, pages)
    if gaps:
        report += ["", "## Plans the suppliers list that the registry does not carry", "",
                   "| Supplier | Result | Plan |", "|---|---|---|", *gaps]
    (ROOT / "verify_report.md").write_text("\n".join(report) + "\n")
    print("\n".join(report))

    if apply:
        for t in tariffs:
            if t.get("id") != "__meta__" and t.get("rates"):
                fill_unused_bands(t)
        TARIFFS.write_text(json.dumps(tariffs, ensure_ascii=False, indent=2) + "\n")
        write_embedded(tariffs)
    return 1 if (changed or unreadable or gaps) else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
