#!/usr/bin/env python3
"""
Probes for the seven plans the scraper cannot yet verify, run from a CI runner
(the supplier sites are unreachable from the dev container). Prints only.

  Yuno       — the site serves an incomplete TLS chain; can we fetch the missing
               intermediate from the leaf's AIA extension and complete it?
  Flogas     — the nav is script-rendered; is there a sitemap or a price PDF?
  BG-EV      — the plan feed omits the overnight EV band; does the EV comparison
               page carry it in prose or its own JSON?
  EN-EV-PLUS — not on /energy-plans/electricity; where is it?
  Dynamic    — do BG/EI/EN publish the fixed BASE rates of their dynamic plans?
"""
from __future__ import annotations

import re
import ssl
import socket
import subprocess
import sys
from urllib.parse import urljoin, urlparse

import requests
import certifi
from bs4 import BeautifulSoup

from sources import fetch, embedded_json, walk, pdf_text, HEADERS

RULE = "=" * 72
S = requests.Session()


# ---------------------------------------------------------------------------
# Yuno — complete the broken chain with the intermediate named in the leaf cert
# ---------------------------------------------------------------------------

def _leaf_der(host: str, port: int = 443) -> bytes:
    ctx = ssl._create_unverified_context()
    with socket.create_connection((host, port), timeout=15) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as ss:
            return ss.getpeercert(binary_form=True)


def _aia_ca_issuers(der: bytes) -> list[str]:
    """CA Issuers URLs from the leaf cert's Authority Information Access."""
    try:
        from cryptography import x509
        from cryptography.x509.oid import ExtensionOID, AuthorityInformationAccessOID
        cert = x509.load_der_x509_certificate(der)
        aia = cert.extensions.get_extension_for_oid(
            ExtensionOID.AUTHORITY_INFORMATION_ACCESS).value
        return [d.access_location.value for d in aia
                if d.access_method == AuthorityInformationAccessOID.CA_ISSUERS]
    except Exception as e:
        print(f"    AIA parse failed: {type(e).__name__}: {e}")
        return []


def yuno():
    print(f"\n{RULE}\nYUNO · TLS chain + intermediate completion\n{RULE}")
    host = "www.yunoenergy.ie"
    # 1. how many certs does the server actually send?
    try:
        out = subprocess.run(
            ["openssl", "s_client", "-connect", f"{host}:443",
             "-servername", host, "-showcerts"],
            input=b"", capture_output=True, timeout=20)
        n = out.stdout.count(b"BEGIN CERTIFICATE")
        print(f"  server sent {n} certificate(s) (a complete chain is usually 2+)")
    except Exception as e:
        print(f"  openssl probe failed: {type(e).__name__}: {e}")

    # 2. read the leaf, find the intermediate it points to, fetch it, retry.
    try:
        der = _leaf_der(host)
        issuers = _aia_ca_issuers(der)
        print(f"  leaf AIA caIssuers: {issuers}")
        if not issuers:
            return
        inter = requests.get(issuers[0], timeout=15)
        inter_der = inter.content
        # AIA usually serves DER; convert to PEM and append to a bundle.
        from cryptography import x509
        try:
            inter_cert = x509.load_der_x509_certificate(inter_der)
        except Exception:
            inter_cert = x509.load_pem_x509_certificate(inter_der)
        from cryptography.hazmat.primitives.serialization import Encoding
        inter_pem = inter_cert.public_bytes(Encoding.PEM)
        print(f"    fetched intermediate: {inter_cert.subject.rfc4514_string()}")

        import tempfile, os
        with open(certifi.where(), "rb") as f:
            base = f.read()
        with tempfile.NamedTemporaryFile("wb", suffix=".pem", delete=False) as tf:
            tf.write(base)
            tf.write(b"\n")
            tf.write(inter_pem)
            bundle = tf.name
        for path in ("/our-tariffs", "/plans", "/"):
            try:
                r = S.get(urljoin(f"https://{host}", path), headers=HEADERS,
                          timeout=20, verify=bundle)
                text = BeautifulSoup(r.text, "lxml").get_text(" ", strip=True)
                m = re.search(r"\d{1,2}\.\d{1,2}\s*c", text)
                print(f"    GET {path} -> {r.status_code}, {len(text)}c, "
                      f"cent-figure={'YES' if m else 'no'}")
                if m:
                    print("      ..." + text[max(0, m.start()-100):m.start()+260] + "...")
            except Exception as e:
                print(f"    GET {path} with completed chain FAILED: {type(e).__name__}: {e}")
        os.unlink(bundle)
    except Exception as e:
        print(f"  intermediate completion failed: {type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# Flogas — find a static price source
# ---------------------------------------------------------------------------

def flogas():
    print(f"\n{RULE}\nFLOGAS · sitemap, PDFs, candidate paths\n{RULE}")
    root = "https://www.flogas.ie/"
    sm = fetch(urljoin(root, "/sitemap.xml"), session=S)
    print(f"  sitemap.xml: {sm.kind} {sm.status}")
    if sm.ok:
        locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", sm.text)
        hits = [u for u in locs if re.search(r"tariff|price|plan|rate|electric", u, re.I)]
        print(f"    {len(locs)} urls, {len(hits)} price-ish:")
        for u in hits[:20]:
            print(f"      {u}")
    home = fetch(root, session=S)
    print(f"  homepage: {home.kind} {home.status} {len(home.text)}c")
    if home.ok:
        soup = BeautifulSoup(home.text, "lxml")
        pdfs = [urljoin(root, a["href"]) for a in soup.find_all("a", href=True)
                if ".pdf" in a["href"].lower()]
        print(f"    {len(pdfs)} PDF links on homepage:")
        for p in list(dict.fromkeys(pdfs))[:15]:
            print(f"      {p}")
    # read the actual per-plan pages and dump the rate region
    for url in ["https://www.flogas.ie/price-plan/single-smart-elec-26-discount/",
                "https://www.flogas.ie/price-plan/smart-nhh-standard-variable-electricity/",
                "https://www.flogas.ie/price-plan/smart-ev-night-16-electricity/"]:
        g = fetch(url, session=S)
        print(f"  --- {g.kind} {g.status}  {url}")
        if not g.ok:
            continue
        t = BeautifulSoup(g.text, "lxml").get_text(" ", strip=True)
        m = re.search(r"\d{1,2}\.\d{1,2}\s*c", t)
        if m:
            print("      " + t[max(0, m.start()-160):m.start()+500])
        else:
            print(f"      no cent figure; {len(t)}c")


# ---------------------------------------------------------------------------
# Bord Gáis EV — the comparison page's own rates
# ---------------------------------------------------------------------------

def bg_ev():
    print(f"\n{RULE}\nBORD GÁIS EV · ev-plan-comparison page\n{RULE}")
    for url in ["https://www.bordgaisenergy.ie/home/ev-plan-comparison",
                "https://www.bordgaisenergy.ie/home/our-plans?fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&ev=true"]:
        g = fetch(url, session=S)
        print(f"  {g.kind} {g.status}  {url}")
        if not g.ok:
            continue
        # look for an EV / overnight rate around 8-10c in embedded JSON
        for blob in embedded_json(g.text):
            for path, val in walk(blob):
                if re.search(r"ev|night|overnight|super|boost", path, re.I) and \
                   isinstance(val, (int, float)) and 5 <= float(val) <= 15:
                    print(f"    JSON {path} = {val}")
        text = BeautifulSoup(g.text, "lxml").get_text(" ", strip=True)
        for m in re.finditer(r"(\d{1,2}\.\d{1,2})\s*c[^.]{0,40}", text):
            v = float(m.group(1))
            if 5 <= v <= 12:
                print(f"    prose low-rate: {m.group(0)!r}")


# ---------------------------------------------------------------------------
# Energia EV Smart Drive Plus, and dynamic base rates
# ---------------------------------------------------------------------------

def energia_extra():
    print(f"\n{RULE}\nENERGIA · EV Smart Drive Plus + dynamic base\n{RULE}")
    for url in ["https://www.energia.ie/energy-plans/electricity",
                "https://www.energia.ie/our-tariffs",
                "https://www.energia.ie/energy-plans"]:
        g = fetch(url, session=S)
        print(f"  {g.kind} {g.status}  {url}")
        if not g.ok:
            continue
        text = BeautifulSoup(g.text, "lxml").get_text(" ", strip=True)
        for kw in ["EV Smart Drive Plus", "Smart Drive Plus", "Dynamic"]:
            i = text.find(kw)
            if i != -1:
                print(f"    '{kw}': ...{text[i:i+240]}...")


def dynamic():
    print(f"\n{RULE}\nDYNAMIC BASE RATES · BG / EI / EN\n{RULE}")
    for name, url in [
        ("EI-DYN", "https://www.electricireland.ie/residential/electricity-and-gas/dynamic"),
        ("BG-DYN", "https://www.bordgaisenergy.ie/home/our-plans?fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES"),
        ("EN-DYN", "https://www.energia.ie/energy-plans/electricity"),
    ]:
        g = fetch(url, session=S)
        print(f"  {name}: {g.kind} {g.status}  {url}")
        if g.ok:
            text = BeautifulSoup(g.text, "lxml").get_text(" ", strip=True)
            i = text.lower().find("dynamic")
            if i != -1:
                print(f"    ...{text[i:i+260]}...")


if __name__ == "__main__":
    which = sys.argv[1:] or ["yuno", "flogas", "bg_ev", "energia_extra", "dynamic"]
    fns = {"yuno": yuno, "flogas": flogas, "bg_ev": bg_ev,
           "energia_extra": energia_extra, "dynamic": dynamic}
    for k in which:
        try:
            fns[k]()
        except Exception as e:
            print(f"  {k} CRASHED: {type(e).__name__}: {e}")
