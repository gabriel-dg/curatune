"""Retention of plans and backups in the data dir.

Plan files and plan backups keep copies of Spotify metadata (track names and artists), and Spotify's
Developer Terms (IV.3) forbid storing Spotify Content indefinitely. So the ones older than the retention
period (`CURATUNE_RETENTION_DAYS`, default 90) are deleted when a command that uses data, or the MCP
server, starts. Only curatune's own file names are touched: plan files (`<plan_id>.json`) and backups
(`<playlist_id>-<UTC timestamp>-before-<plan_id>.json`). Recording dates are the user's own data and stay.
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any

from .config import Settings
from .errors import ConfigError
from .plans import PLAN_ID_RE

DEFAULT_RETENTION_DAYS = 90
_BACKUP_RE = re.compile(r"^[A-Za-z0-9]{22}-\d{8}T\d{6}Z-before-(?P<plan_id>[^/\\]+)\.json$")


def retention_days() -> int:
    raw = (os.environ.get("CURATUNE_RETENTION_DAYS") or "").strip()
    if not raw:
        return DEFAULT_RETENTION_DAYS
    try:
        days = int(raw)
    except ValueError:
        raise ConfigError("CURATUNE_RETENTION_DAYS must be a whole number of days.", details={"value": raw}) from None
    if days < 1:
        raise ConfigError("CURATUNE_RETENTION_DAYS must be at least 1.", details={"value": days})
    return days


def _is_plan_file(name: str) -> bool:
    return name.endswith(".json") and PLAN_ID_RE.match(name[: -len(".json")]) is not None


def _is_backup_file(name: str) -> bool:
    match = _BACKUP_RE.match(name)
    return match is not None and PLAN_ID_RE.match(match["plan_id"]) is not None


def prune(settings: Settings, now: float | None = None) -> dict[str, Any]:
    """Delete plan files and backups last written more than the retention period ago. Never fails a
    command: a file that can't be deleted now is tried again next time."""
    days = retention_days()
    cutoff = (time.time() if now is None else now) - days * 86400
    removed = {"plans": 0, "backups": 0}
    folders: tuple[tuple[str, Path, Any], ...] = (
        ("plans", settings.plans_dir, _is_plan_file),
        ("backups", settings.backups_dir, _is_backup_file),
    )
    for kind, folder, is_ours in folders:
        if not folder.is_dir():
            continue
        for path in folder.iterdir():
            try:
                if path.is_file() and is_ours(path.name) and path.stat().st_mtime < cutoff:
                    path.unlink()
                    removed[kind] += 1
            except OSError:
                continue
    return {"retention_days": days, "removed": removed}
