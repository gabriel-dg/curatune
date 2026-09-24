"""Per-process HTTP counters, reported by the CLI in each envelope's `meta` block.

Two kinds are tracked: "api" (Spotify Web API requests, retries included) and "auth"
(accounts service: token exchange/refresh, plus the user lookup right after login).
"""

from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from typing import Iterator

_stats: dict[str, list[float]] = {}
_lock = threading.Lock()


def reset() -> None:
    with _lock:
        _stats.clear()


@contextmanager
def timed(kind: str) -> Iterator[None]:
    """Count one request. With concurrent requests, `ms` is the sum of their durations (busy time),
    which can exceed the command's wall-clock `elapsed_ms`."""
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed = (time.perf_counter() - start) * 1000
        with _lock:
            entry = _stats.setdefault(kind, [0, 0.0])
            entry[0] += 1
            entry[1] += elapsed


def snapshot() -> dict[str, dict[str, float]]:
    with _lock:
        return {kind: {"calls": int(calls), "ms": round(ms, 1)} for kind, (calls, ms) in sorted(_stats.items())}
