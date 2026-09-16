#!/usr/bin/env python3
"""
Fold the harvested full catalogue into the app's registry.

The harvester reads every plan a supplier lists. The app's registry carries
hand-checked plan IDs that code, tests and affiliate links all key on. Neither
is a superset of the other: the harvest finds offers the registry never had,
and the registry carries verification notes and windows the harvest cannot see.

So this merges rather than replaces. A harvested plan is added only when:

  * no registry plan for that supplier has the same rate shape — otherwise it
    is the same offer under the harvester's slugified name, and adding it would
    show the reader the same plan twice; and
  * the app can price it honestly. Two families fail this and are excluded on
    purpose, named in SKIP below: Bord Gais's EV plans, whose feed omits the
    overnight band so the harvest reads the EV rate as the night rate and
    under-prices the plan badly, and the weekend plans, whose whole value is a
    weekend discount the engine has no band for.

Anything ambiguous is left out and reported, not guessed at.

Usage:  python scraper/merge_catalogue.py <harvest.json> [--write]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "public" / "tariffs.json"
MAIN_JS = ROOT / "src" / "main.js"

# Harvested IDs we refuse to carry, and why. Being explicit here means a future
# run cannot quietly start including them.
SKIP = {
    "BG-SMART-EV-ELECTRICITY-DISCOUNT": "BG feed omits the overnight band — ev rate reads as the night rate",
    "BG-SMART-EV-PLUS-ELECTRICITY-DISCOUNT": "same overnight-band gap as the other BG EV plan",
    "BG-SMART-WEEKEND-ELECTRICITY-DISCOUNT": "weekend discount has no band in the engine — would be priced as a plain DNP",
    "BG-SMART-WEEKEND-ELECTRICITY-DISCOUNT-2": "same weekend band gap",
    "SSE-1-YEAR-HOME-ELECTRICITY-24HR-2": "second SSE 24hr offer at a different rate, identity unresolved",
    "SSE-1-YEAR-HOME-ELECTRICITY-SMART-DNP-2": "second SSE DNP offer at a different rate, identity unresolved",
    "EI-SMART-DAY-NIGHT": "same rates as the Nightsaver plan already carried",
}

# The supplier-wide rises already announced, so a newly carried plan warns about
# them exactly as its siblings do. Keyed by supplier.
ANNOUNCED = {
    "Bord Gáis": {
        "effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072,
        "direction": "increase",
        "source": "Bord Gais price announcement, 9 Sep 2026",
        "note": "Bord Gais unit rates +9.1%, standing +7.2% from 9 Oct 2026.",
    },
    "Energia": {
        "effective_date": "2026-10-12", "pct": 0.03,
        "pct_bands": {"day": 0.03, "night": 0.28, "peak": 0.05, "ev": 0.28},
        "standing_pct": 0.05, "direction": "increase",
        "source": "energia.ie price notice, announced Sep 2026",
        "note": "Energia rates rise 12 Oct 2026: night ~+28%, day ~+3%, peak ~+5%, standing +5%.",
    },
}

BANDS = ("day", "night", "peak", "ev")


def shape(plan: dict) -> tuple:
    """A plan's rate fingerprint, to the hundredth of a cent."""
    r = plan.get("rates") or {}
    return tuple(round(float(r.get(b) or 0), 4) for b in BANDS)


def plans(doc: list) -> list:
    return [p for p in doc if p.get("id") != "__meta__"]


def template_for(supplier: str, is_flat: bool, registry: list) -> dict | None:
    """A carried plan of the same supplier and shape, to inherit conventions."""
    for p in registry:
        if p.get("supplier") != supplier or p.get("type") == "dynamic":
            continue
        flat = len(set(shape(p))) == 1
        if flat == is_flat:
            return p
    return next((p for p in registry if p.get("supplier") == supplier), None)


def merge(harvest: list, registry: list) -> tuple[list, list, list]:
    carried = plans(registry)
    known = {(p["supplier"], shape(p)) for p in carried}
    known_ids = {p["id"] for p in carried}
    added, skipped = [], []

    for h in plans(harvest):
        hid = h["id"]
        if hid in SKIP:
            skipped.append((hid, SKIP[hid]))
            continue
        if hid in known_ids:
            continue
        key = (h["supplier"], shape(h))
        if key in known:
            skipped.append((hid, "same rates as a plan already carried"))
            continue

        is_flat = len(set(shape(h))) == 1
        tpl = template_for(h["supplier"], is_flat, carried)
        if not tpl:
            skipped.append((hid, "no carried plan for this supplier to inherit windows from"))
            continue

        plan = {
            "id": hid,
            "supplier": h["supplier"],
            "plan": h["plan"],
            "type": "flat" if is_flat else "tou",
            "rates": {b: round(float(h["rates"].get(b) or 0), 4) for b in BANDS},
            "windows": json.loads(json.dumps(tpl.get("windows") or {"ev": None})),
            "standing": h.get("standing", tpl.get("standing")),
            "exit": tpl.get("exit", 50),
            "length": tpl.get("length", 12),
            "green": tpl.get("green", False),
            "export_rate": tpl.get("export_rate", 0.185),
            "verified_date": h.get("verified_date"),
            "notes": (
                f"Harvested {h.get('verified_date')} from the supplier's own plan list. "
                f"Rates and standing charge are as published; windows and export rate "
                f"follow {tpl['supplier']} — {tpl['plan']}. Not yet hand-checked against "
                f"a second source — confirm with the supplier before switching."
            ),
        }
        if h["supplier"] in ANNOUNCED:
            plan["price_change"] = json.loads(json.dumps(ANNOUNCED[h["supplier"]]))
            if is_flat:
                plan["price_change"].pop("pct_bands", None)
        added.append(plan)
        known.add(key)
        known_ids.add(hid)

    out = list(registry) + added
    return out, added, skipped


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    harvest = json.loads(Path(sys.argv[1]).read_text())
    registry = json.loads(REGISTRY.read_text())
    merged, added, skipped = merge(harvest, registry)

    print(f"carried {len(plans(registry))} → {len(plans(merged))} plans\n")
    print("ADDED")
    for p in added:
        r = p["rates"]
        print(f"  {p['id']:<46} {p['supplier']} — {p['plan']}")
        print(f"     day {r['day']} night {r['night']} peak {r['peak']} ev {r['ev']} · standing {p['standing']}")
    print("\nSKIPPED")
    for pid, why in skipped:
        print(f"  {pid:<46} {why}")

    if "--write" in sys.argv:
        REGISTRY.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n")
        print(f"\nwrote {REGISTRY}")
    else:
        print("\n(dry run — pass --write to apply)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
