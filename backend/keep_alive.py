#!/usr/bin/env python3
"""
Keep-alive and auto-reconnect health monitor for free-tier Instabox cloud VMs.

Behavior:
- Pings GET <server>/health every 18 minutes while alive (prevents 30-min inactivity sleep).
- On failure (connection error, non-200, timeout, or invalid JSON) switches to retry mode,
  pinging every 60 seconds until the server recovers after its 20-30 minute cooldown.
- Logs the total downtime duration upon recovery and resumes 18-minute pings.
- Standalone script requiring only `requests`.
"""

import argparse
import sys
import time
from datetime import datetime
from typing import Tuple

import requests

DEFAULT_HEALTH_URL = "https://8000-agq75oq6i7eazd5pahfhehvvj4.instabox.tech/health"
ALIVE_INTERVAL_SEC = 18 * 60  # 18 minutes
RETRY_INTERVAL_SEC = 60       # 60 seconds
REQUEST_TIMEOUT_SEC = 10


def normalize_health_url(raw_url: str) -> str:
    url = raw_url.strip().rstrip("/")
    if not url.endswith("/health"):
        url = f"{url}/health"
    return url


def timestamp() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def format_duration(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours > 0:
        return f"{hours}h {minutes}m {secs}s"
    if minutes > 0:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


def check_health(url: str) -> Tuple[bool, str]:
    try:
        response = requests.get(url, timeout=REQUEST_TIMEOUT_SEC)
        if response.status_code != 200:
            return False, f"HTTP {response.status_code}"
        payload = response.json()
        if isinstance(payload, dict) and payload.get("status") == "ok":
            return True, "status=ok"
        return False, "unexpected JSON payload"
    except requests.Timeout:
        return False, "timeout"
    except requests.ConnectionError:
        return False, "connection error"
    except requests.RequestException as exc:
        return False, str(exc)
    except ValueError:
        return False, "invalid JSON response"


def interruptible_sleep(seconds: int) -> None:
    end_time = time.monotonic() + seconds
    while True:
        remaining = end_time - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(1.0, remaining))


def print_banner(url: str) -> None:
    line = "=" * 64
    print(line)
    print("  Flow Backend Keep-Alive & Auto-Reconnect Monitor")
    print(line)
    print(f"  Target URL      : {url}")
    print(f"  Alive Interval  : {ALIVE_INTERVAL_SEC // 60} minutes ({ALIVE_INTERVAL_SEC}s)")
    print(f"  Retry Interval  : {RETRY_INTERVAL_SEC} seconds (during cooldown/offline)")
    print("  Press Ctrl+C to stop.")
    print(line, flush=True)


def run_monitor(url: str) -> None:
    print_banner(url)
    down_since: float | None = None

    while True:
        alive, detail = check_health(url)

        if alive:
            if down_since is not None:
                downtime = time.monotonic() - down_since
                print(
                    f"[{timestamp()}] alive ✓  (recovered after {format_duration(downtime)} downtime — resuming {ALIVE_INTERVAL_SEC // 60}m interval)",
                    flush=True,
                )
                down_since = None
            else:
                print(f"[{timestamp()}] alive ✓  ({detail})", flush=True)

            interruptible_sleep(ALIVE_INTERVAL_SEC)
        else:
            if down_since is None:
                down_since = time.monotonic()
                print(
                    f"[{timestamp()}] offline ✗ ({detail} — switching to {RETRY_INTERVAL_SEC}s retry mode)",
                    flush=True,
                )
            else:
                print(f"[{timestamp()}] offline ✗ ({detail})", flush=True)

            interruptible_sleep(RETRY_INTERVAL_SEC)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Keep-alive and auto-reconnect health monitor for the Flow backend server."
    )
    parser.add_argument(
        "url",
        nargs="?",
        default=DEFAULT_HEALTH_URL,
        help=f"Target health check URL or base server URL (default: {DEFAULT_HEALTH_URL})",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    target_url = normalize_health_url(args.url)
    try:
        run_monitor(target_url)
    except KeyboardInterrupt:
        print(f"\n[{timestamp()}] Monitor stopped gracefully. Goodbye.", flush=True)
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
