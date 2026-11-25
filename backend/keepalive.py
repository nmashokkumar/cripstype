#!/usr/bin/env python3
"""Keep-alive and auto-reconnect monitor for the Flow Instabox backend."""

from __future__ import annotations

import argparse
from datetime import datetime
import sys
import time

import requests

DEFAULT_SERVER_URL = "https://8000-agq75oq6i7eazd5pahfhehvvj4.instabox.tech"
ALIVE_INTERVAL_SECONDS = 18 * 60
RETRY_INTERVAL_SECONDS = 60
REQUEST_TIMEOUT_SECONDS = 10


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def format_duration(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    parts = []
    if hours:
        parts.append(f"{hours}h")
    if minutes or hours:
        parts.append(f"{minutes}m")
    parts.append(f"{secs}s")
    return " ".join(parts)


def normalize_health_url(server_url: str) -> str:
    cleaned = server_url.strip().rstrip("/")
    if cleaned.endswith("/health"):
        return cleaned
    return f"{cleaned}/health"


def ping_health(health_url: str) -> tuple[bool, str]:
    try:
        response = requests.get(health_url, timeout=REQUEST_TIMEOUT_SECONDS)
        if response.status_code != 200:
            return False, f"HTTP {response.status_code}"
        data = response.json()
        if isinstance(data, dict) and data.get("status") == "ok":
            return True, "ok"
        return False, "unexpected payload"
    except requests.RequestException as exc:
        return False, exc.__class__.__name__
    except ValueError:
        return False, "invalid JSON"


def print_banner(health_url: str) -> None:
    print("=" * 64)
    print("Flow Backend Keep-Alive Monitor")
    print(f"Target URL    : {health_url}")
    print("Ping Interval : 18 minutes (alive) / 60 seconds (retry)")
    print("=" * 64, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Instabox backend keep-alive ping monitor")
    parser.add_argument(
        "server_url",
        nargs="?",
        default=DEFAULT_SERVER_URL,
        help=f"Base server URL or /health URL (default: {DEFAULT_SERVER_URL})",
    )
    args = parser.parse_args()

    health_url = normalize_health_url(args.server_url)
    print_banner(health_url)

    in_retry_mode = False
    downtime_started_at: float | None = None

    try:
        while True:
            alive, detail = ping_health(health_url)

            if alive:
                if in_retry_mode and downtime_started_at is not None:
                    downtime_duration = time.monotonic() - downtime_started_at
                    print(
                        f"[{now_str()}] alive ✓  (recovered after {format_duration(downtime_duration)} downtime; resuming 18-min pings)",
                        flush=True,
                    )
                    in_retry_mode = False
                    downtime_started_at = None
                else:
                    print(f"[{now_str()}] alive ✓", flush=True)
                sleep_seconds = ALIVE_INTERVAL_SECONDS
            else:
                if not in_retry_mode:
                    in_retry_mode = True
                    downtime_started_at = time.monotonic()
                print(f"[{now_str()}] offline ✗ ({detail})", flush=True)
                sleep_seconds = RETRY_INTERVAL_SECONDS

            time.sleep(sleep_seconds)
    except KeyboardInterrupt:
        print(f"\n[{now_str()}] Keep-alive stopped by user.", flush=True)
        sys.exit(0)


if __name__ == "__main__":
    main()
