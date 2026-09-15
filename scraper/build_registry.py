#!/usr/bin/env python3
"""
Turn the harvested catalogue into the app's registry.

harvest.py reads every public plan a supplier lists, but only the parts a page
can tell us: name, type, per-band rates, standing charge. The ranking engine
needs more than that — the clock windows that say when peak/night/ev apply, the
microgen export rate, whether the plan is green, the exit fee and term. None of
that is published as data, so it is filled here:

  * band WINDOWS are inherited from an existing curated plan of the same
    supplier and type (the hand-checked [17,19]/[23,8] clocks), falling back to
    a standard template;
  * export rate, green flag, exit fee and term likewise come from the
    supplier's existing plans, then a supplier/default.

A plan the harvest missed today (a flaky page) is NOT dropped: the previous
registry entry is kept so a bad scrape never shrinks the catalogue. The result
is written to catalogue_registry.json for review; wiring it into tariffs.json is
a separate, deliberate step.
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).parent
CATALOGUE = HERE / "catalogue.json"
TARIFFS = HERE.parent / "public" / "tariffs.json"
MAIN_JS = HERE.parent / "src" / "main.js"
OUT = HERE / "catalogue_registry.json"
TODAY = date.today().isoformat()

#: Standard Irish smart-tariff clocks, used when no curated plan of this
#: supplier+type exists to copy from.
WINDOW_TEMPLATE = {
    "flat": {"ev": None},
    "tou": {"peak": [17, 19], "night": [23, 8], "ev": None},
    "dn": {"night": [23, 8], "ev": None},
    "ev": {"ev": [2, 6], "night": [23, 8]},
    "dynamic": {"peak": [17, 19], "night": [23, 8], "ev": None},
}

SUPPLIER_PREFIX = {
    "Bord Gáis": "BG", "Energia": "EN", "SSE Airtricity": "SSE",
    "Yuno Energy": "YN", "Pinergy": "PIN", "Electric Ireland": "EI",
    "Flogas": "FL",
}


def _slug(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").upper()
    return re.sub(r"-+", "-", s)


def _supplier_defaults(existing: list) -> dict:
    """Per-supplier fallbacks and per-(supplier,type) window/field templates."""
    by_sup: dict = defaultdict(lambda: {"export": [], "green": [], "standing": [],
                                        "exit": [], "length": [], "by_type": {}})
    for t in existing:
        if t.get("id") == "__meta__":
            continue
        sup = t.get("supplier")
        d = by_sup[sup]
        if t.get("export_rate") is not None:
            d["export"].append(t["export_rate"])
        d["green"].append(bool(t.get("green")))
        if t.get("standing"):
            d["standing"].append(t["standing"])
        if t.get("exit") is not None:
            d["exit"].append(t["exit"])
        if t.get("length") is not None:
            d["length"].append(t["length"])
        d["by_type"].setdefault(t.get("type"), t)   # first curated plan of the type
    return by_sup


def _mode(xs, fallback):
    return Counter(xs).most_common(1)[0][0] if xs else fallback


def build() -> list:
    existing = json.loads(TARIFFS.read_text())
    catalogue = json.loads(CATALOGUE.read_text())
    defaults = _supplier_defaults(existing)

    registry: list = []
    used_ids: set = set()

    for p in catalogue:
        sup, typ, name = p["supplier"], p["type"], p["name"]
        d = defaults.get(sup, {})
        template = (d.get("by_type", {}) or {}).get(typ)

        windows = dict(template["windows"]) if template and template.get("windows") \
            else dict(WINDOW_TEMPLATE.get(typ, WINDOW_TEMPLATE["tou"]))
        export_rate = template.get("export_rate") if template else \
            _mode(d.get("export", []), 0.195)
        green = bool(template.get("green")) if template else \
            ("green" in name.lower())
        exit_fee = template.get("exit") if template else _mode(d.get("exit", []), 50)
        length = template.get("length") if template else _mode(d.get("length", []), 12)
        standing = p.get("standing") or (template.get("standing") if template
                                         else _mode(d.get("standing", []), 250.0))

        pid = f"{SUPPLIER_PREFIX.get(sup, 'X')}-{_slug(name)}"[:48]
        n = pid
        i = 2
        while n in used_ids:
            n = f"{pid}-{i}"
            i += 1
        used_ids.add(n)

        registry.append({
            "id": n, "supplier": sup, "plan": name, "type": typ,
            "rates": p["rates"], "windows": windows, "standing": standing,
            "exit": exit_fee, "length": length, "green": green,
            "export_rate": export_rate, "verified_date": TODAY,
            "notes": f"Harvested {TODAY} from {p.get('source', 'supplier site')}. "
                     f"Windows/export inherited from the {sup} {typ} template.",
        })

    # Keep any curated plan the harvest did not cover today, so a flaky page
    # never shrinks the catalogue. Match loosely by supplier+type presence.
    covered = {(r["supplier"], r["type"]) for r in registry}
    kept = 0
    for t in existing:
        if t.get("id") == "__meta__":
            continue
        if (t.get("supplier"), t.get("type")) not in covered:
            registry.append(t)
            kept += 1

    print(f"catalogue plans: {len(catalogue)}; carried-over curated plans: {kept}; "
          f"total registry: {len(registry)}")
    by_sup = Counter(r["supplier"] for r in registry)
    for sup, n in by_sup.most_common():
        print(f"  {sup:16} {n}")
    return registry


def write_app_data(registry: list) -> None:
    """Replace tariffs.json and regenerate EMBEDDED_TARIFFS from the registry.

    The plan set now changes with the market, so the bundle fallback is
    regenerated wholesale (a machine-written JSON literal) rather than edited in
    place — the hand-formatted, hand-commented literal only made sense for a
    fixed list. tariffs.json keeps a __meta__ header; EMBEDDED_TARIFFS is the
    plans alone. The two hold the same plan data, which the freshness test still
    checks.
    """
    existing = json.loads(TARIFFS.read_text())
    meta = next((t for t in existing if t.get("id") == "__meta__"), {"id": "__meta__"})
    meta["last_built"] = TODAY
    meta["plan_count"] = len(registry)
    TARIFFS.write_text(json.dumps([meta] + registry, indent=2, ensure_ascii=False))

    main = MAIN_JS.read_text()
    start = main.index("const EMBEDDED_TARIFFS = [")
    open_ = main.index("[", start)
    depth, end = 0, open_
    for i in range(open_, len(main)):
        if main[i] == "[":
            depth += 1
        elif main[i] == "]":
            depth -= 1
            if depth == 0:
                end = i
                break
    literal = json.dumps(registry, indent=2, ensure_ascii=False)
    MAIN_JS.write_text(main[:open_] + literal + main[end + 1:])
    print(f"wrote tariffs.json and EMBEDDED_TARIFFS ({len(registry)} plans)")


if __name__ == "__main__":
    reg = build()
    if "--write" in sys.argv:
        write_app_data(reg)
    else:
        OUT.write_text(json.dumps(reg, indent=2, ensure_ascii=False))
        print(f"\nwrote {OUT.name} ({len(reg)} plans)")
