#!/usr/bin/env python3
"""
Headless rendering for the one supplier whose rates never reach the HTML.

Every other supplier serves its numbers in the page, its embedded JSON, or a
PDF, and is read with a plain request. Flogas renders its price tables entirely
in the browser: the HTML and its JSON carry zero rate figures. The only way to
read them is to run the page's JavaScript, so this drives a headless Chromium.

It is deliberately isolated and lazy: `render_html` imports Playwright only when
called, and every caller treats an empty string as "could not render" and falls
back rather than failing the run. A browser is heavier and less stable than a
GET, so nothing depends on it that a static source can satisfy.
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)


def render_html(url: str, timeout_ms: int = 45000,
                wait_selector: str | None = None) -> str:
    """Fully-rendered HTML for `url`, or "" if the browser is unavailable."""
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:                      # not installed / no browser
        log.warning(f"Playwright unavailable ({e}); cannot render {url}")
        return ""
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--no-sandbox"])
            page = browser.new_page(user_agent=(
                "Mozilla/5.0 (compatible; SolarOptimiserBot/1.0; "
                "+https://github.com/islamattia85/sawed)"))
            try:
                page.goto(url, timeout=timeout_ms, wait_until="networkidle")
                if wait_selector:
                    page.wait_for_selector(wait_selector, timeout=timeout_ms)
                return page.content()
            finally:
                browser.close()
    except Exception as e:
        log.warning(f"render failed for {url}: {type(e).__name__}: {e}")
        return ""
