#!/usr/bin/env python3
"""
Check hiz.al shorturl redirect targets for dead destinations.

Default: dry-run (report only). Pass --delete to remove dead shorturl dirs.

Handles more than bare HTTP status:
  - Dropbox shared links that return 200 but show File Deleted / disabled
  - Cloudflare origin-DNS / host-dead challenge pages (e.g. 8tracks)
  - Soft-alive bot challenges (e.g. photography.hizalcelik.com) stay non-deleting

Usage:
  python3 scripts/check-dead-links.py
  python3 scripts/check-dead-links.py --delete
  python3 scripts/check-dead-links.py --timeout 15 --workers 16
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import shutil
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent

# Never treat these as shorturl candidates for deletion.
PROTECTED_DIRS = {
    "pwd",  # password app
    ".git",
    "node_modules",
    "scripts",
}

# Local / relative redirects (always considered alive).
LOCAL_PREFIXES = ("/", "#")

REFRESH_RE = re.compile(
    r"""content\s*=\s*["']\s*0\s*;\s*URL\s*=\s*['"]?([^'"\s>]+)['"]?""",
    re.IGNORECASE,
)
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

# Status codes that clearly mean the resource is gone.
DEAD_STATUSES = {404, 410, 451}

# Soft-alive: destination exists but may block bots / require auth / rate-limit.
SOFT_ALIVE_STATUSES = {401, 403, 429, 999}

# Max response body to inspect for soft-dead page content.
BODY_LIMIT = 512_000


@dataclass
class LinkResult:
    slug: str
    path: Path
    url: str | None
    status: str  # alive | soft-alive | dead | skipped | error | no-url
    detail: str
    http_code: int | None = None


def extract_redirect_url(index_html: Path) -> str | None:
    try:
        text = index_html.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    match = REFRESH_RE.search(text)
    if not match:
        return None
    return match.group(1).strip()


def is_local_url(url: str) -> bool:
    return url.startswith(LOCAL_PREFIXES)


def page_title(body: str) -> str:
    match = TITLE_RE.search(body)
    if not match:
        return ""
    return re.sub(r"\s+", " ", match.group(1)).strip()


def classify_body(url: str, final_url: str, body: str) -> tuple[str, str] | None:
    """
    Inspect HTML/body for soft-dead destinations that still return HTTP 200/403.
    Returns (status, detail) or None if no special classification.
    """
    host = urlparse(final_url or url).netloc.lower()
    title = page_title(body)
    title_l = title.lower()
    body_l = body.lower()

    # Cloudflare / host-dead pages that are not transient bot checks.
    if "origin dns error" in title_l or "error 1016" in body_l:
        return "dead", f"Cloudflare origin DNS error (title={title!r})"
    if "dns points to prohibited ip" in title_l or "error 1000" in body_l:
        return "dead", f"Cloudflare DNS error (title={title!r})"
    if "host error" in title_l and "cloudflare" in body_l:
        return "dead", f"Cloudflare host error (title={title!r})"
    if "web server is down" in title_l or "error 521" in body_l:
        return "dead", f"Cloudflare origin down (title={title!r})"

    # Transient bot interstitial — do not delete.
    if "checking your browser" in title_l or "just a moment..." in title_l:
        return "soft-alive", f"bot challenge (title={title!r})"

    # Dropbox shared links often stay HTTP 200 after deletion/disable.
    if "dropbox.com" in host or "dropboxusercontent.com" in host:
        if "file deleted" in title_l or "this item was deleted" in body_l:
            return "dead", f"Dropbox deleted (title={title!r})"
        if "shared_link_disabled" in body_l:
            return "dead", f"Dropbox shared_link_disabled (title={title!r})"
        if re.match(r"^dropbox\s*-\s*error\b", title_l):
            return "dead", f"Dropbox error page (title={title!r})"
        # SPA shell with no share name usually means unresolved/deleted folder.
        if re.fullmatch(r"dropbox", title_l):
            return "dead", f"Dropbox unresolved share (title={title!r})"
        if title:
            return "alive", f"Dropbox ok (title={title!r})"

    return None


def fetch(url: str, timeout: float) -> tuple[int, str, str]:
    """Return (http_code, final_url, body_text). Raises on transport failure."""
    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        url,
        method="GET",
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            code = getattr(resp, "status", None) or resp.getcode()
            final = resp.geturl()
            body = resp.read(BODY_LIMIT).decode("utf-8", errors="replace")
            return code, final, body
    except urllib.error.HTTPError as e:
        body = e.read(BODY_LIMIT).decode("utf-8", errors="replace") if e.fp else ""
        final = e.geturl() if hasattr(e, "geturl") else url
        return e.code, final or url, body


def check_url(url: str, timeout: float) -> tuple[str, str, int | None]:
    """Return (status, detail, http_code)."""
    if is_local_url(url):
        return "skipped", "local/relative redirect", None

    # Prefer Dropbox preview pages over forced downloads so we can read HTML.
    check = url
    if "dropbox.com" in urlparse(url).netloc.lower():
        check = re.sub(r"([?&])dl=1\b", r"\1dl=0", url)

    try:
        code, final, body = fetch(check, timeout)
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", e)
        return "dead", f"URL error: {reason}", None
    except TimeoutError:
        return "error", "timeout", None
    except Exception as e:  # noqa: BLE001 - surface unexpected check failures
        return "error", f"{type(e).__name__}: {e}", None

    special = classify_body(url, final, body)
    if special:
        status, detail = special
        return status, f"{detail} [HTTP {code}]", code

    if code in DEAD_STATUSES:
        return "dead", f"HTTP {code} -> {final}", code
    if code in SOFT_ALIVE_STATUSES:
        return "soft-alive", f"HTTP {code} -> {final}", code
    if 200 <= code < 400:
        return "alive", f"HTTP {code} -> {final}", code
    return "error", f"HTTP {code} -> {final}", code


def discover_links(root: Path) -> list[tuple[str, Path, str | None]]:
    links: list[tuple[str, Path, str | None]] = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name in PROTECTED_DIRS or entry.name.startswith("."):
            continue
        index = entry / "index.html"
        if not index.is_file():
            continue
        url = extract_redirect_url(index)
        links.append((entry.name, entry, url))
    return links


def check_one(
    slug: str, path: Path, url: str | None, timeout: float
) -> LinkResult:
    if not url:
        return LinkResult(slug, path, None, "no-url", "no meta refresh URL found")
    status, detail, code = check_url(url, timeout)
    return LinkResult(slug, path, url, status, detail, code)


def load_overrides(root: Path) -> dict[str, dict]:
    path = root / "scripts" / "dead-link-overrides.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"Warning: could not read overrides: {e}", file=sys.stderr)
        return {}
    by_slug = data.get("bySlug") if isinstance(data, dict) else None
    return by_slug if isinstance(by_slug, dict) else {}


def follow_soft_alive_browser(
    urls: list[str], root: Path
) -> list[dict]:
    """Use Playwright helper to resolve bot-challenged soft-alive URLs."""
    if not urls:
        return []
    helper = root / "scripts" / "follow-soft-alive.mjs"
    if not helper.is_file():
        print("Browser helper missing; leaving soft-alive as-is.", file=sys.stderr)
        return []
    try:
        proc = subprocess.run(
            ["node", str(helper), *urls],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=max(60, 30 * len(urls)),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"Browser follow-up failed: {e}", file=sys.stderr)
        return []
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        print(f"Browser follow-up failed: {err}", file=sys.stderr)
        return []
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        print("Browser follow-up returned invalid JSON.", file=sys.stderr)
        return []
    return data if isinstance(data, list) else []


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Find (and optionally delete) dead hiz.al shorturl redirects."
    )
    parser.add_argument(
        "--delete",
        action="store_true",
        help="Delete shorturl dirs whose targets are dead. Default is dry-run.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=12.0,
        help="Per-request timeout in seconds (default: 12).",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=12,
        help="Concurrent request workers (default: 12).",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=ROOT,
        help="Repo root containing shorturl directories.",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Skip Playwright follow-through for soft-alive/challenged URLs.",
    )
    args = parser.parse_args()

    root = args.root.resolve()
    links = discover_links(root)
    if not links:
        print("No shorturl directories found.")
        return 1

    mode = "DELETE" if args.delete else "DRY-RUN"
    print(f"Checking {len(links)} shorturls under {root} [{mode}]")
    print(f"timeout={args.timeout}s workers={args.workers}\n")

    results: list[LinkResult] = []
    started = time.time()

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(check_one, slug, path, url, args.timeout): slug
            for slug, path, url in links
        }
        for fut in concurrent.futures.as_completed(futures):
            result = fut.result()
            results.append(result)
            mark = {
                "alive": "OK",
                "soft-alive": "SOFT",
                "dead": "DEAD",
                "error": "ERR",
                "skipped": "SKIP",
                "no-url": "NOURL",
            }.get(result.status, result.status.upper())
            target = result.url or "(none)"
            print(f"[{mark:5}] /{result.slug:20} -> {target}")
            if result.status != "alive":
                print(f"         {result.detail}")

    # Apply browser/manual overrides for targets HTTP can't resolve reliably.
    overrides = load_overrides(root)
    if overrides:
        for result in results:
            item = overrides.get(result.slug)
            if not item:
                continue
            result.status = item.get("status", result.status)
            result.detail = item.get("detail", result.detail)
            print(
                f"[OVRD ] /{result.slug:20} => {result.status}: {result.detail}"
            )

    # Follow soft-alive bot challenges in headless Chromium when available.
    soft_pending = [r for r in results if r.status == "soft-alive" and r.url]
    if soft_pending and not args.no_browser:
        print(
            f"\nFollowing {len(soft_pending)} soft-alive URL(s) "
            "through browser challenges..."
        )
        followed = follow_soft_alive_browser(
            [r.url for r in soft_pending if r.url], root
        )
        by_url = {item.get("url"): item for item in followed}
        for result in results:
            if result.status != "soft-alive" or not result.url:
                continue
            item = by_url.get(result.url)
            if not item:
                continue
            result.status = item.get("status") or result.status
            result.detail = item.get("detail") or result.detail
            result.http_code = item.get("http") or result.http_code
            mark = {
                "alive": "OK",
                "soft-alive": "SOFT",
                "dead": "DEAD",
                "error": "ERR",
            }.get(result.status, result.status.upper())
            print(f"[{mark:5}] /{result.slug:20} => {result.detail}")

    results.sort(key=lambda r: r.slug)
    dead = [r for r in results if r.status == "dead"]
    soft = [r for r in results if r.status == "soft-alive"]
    errors = [r for r in results if r.status in {"error", "no-url"}]
    alive = [r for r in results if r.status in {"alive", "skipped"}]

    print("\n" + "=" * 72)
    print(
        f"Done in {time.time() - started:.1f}s | "
        f"alive={len(alive)} soft-alive={len(soft)} "
        f"dead={len(dead)} errors={len(errors)}"
    )

    if soft:
        print("\nSoft-alive (blocked/auth/rate-limit; NOT deleted):")
        for r in soft:
            print(f"  /{r.slug} -> {r.url}  ({r.detail})")

    if errors:
        print("\nErrors / needs review (NOT deleted):")
        for r in errors:
            print(f"  /{r.slug} -> {r.url}  ({r.detail})")

    if dead:
        print("\nDead links:")
        for r in dead:
            print(f"  /{r.slug} -> {r.url}  ({r.detail})")
    else:
        print("\nNo dead links found.")

    if args.delete:
        if not dead:
            print("\nNothing to delete.")
        else:
            print("\nDeleting dead shorturl directories:")
            for r in dead:
                shutil.rmtree(r.path)
                print(f"  removed {r.path.relative_to(root)}/")
    else:
        print("\nDry-run only. Re-run with --delete to remove dead shorturl dirs.")

    return 0 if not dead else 2


if __name__ == "__main__":
    sys.exit(main())
