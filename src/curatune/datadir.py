"""The data directory's guard against data left in a source checkout, and the migration out of it.

Before phase 3 of PLAN-mcp.md, curatune kept its data in the checkout's `data/` (backups, the write log,
recording dates, MCP client records) and `plans/`. It now keeps them in the data dir (config.py). curatune
never starts empty without saying so:
- with the **default** data dir, data still in the checkout blocks every command that uses data, with
  LEGACY_DATA_NOT_MIGRATED, until `curatune data migrate` has copied it;
- with an **explicit** `CURATUNE_DATA_DIR`, the user's choice stands and commands warn
  (LEGACY_DATA_PRESENT) instead;
- after a migration (its marker, `migration.json`, is in the data dir), nothing warns: the originals stay
  in place until the user deletes them, which is never automatic.

`migrate` copies (never moves): a backup of the checkout's folders first, then the copy, then a SHA-256
check of every file in all three places, then the marker. It refuses to overwrite anything.

A data dir that Windows keeps private to a Microsoft Store app is refused too (DATA_DIR_VIRTUALIZED). For
the programs such an app starts (Claude Desktop from the Store starts its Code sessions and MCP servers),
Windows redirects a new top-level folder under AppData to `AppData/Local/Packages/<app>/LocalCache`
(observed 2026-10-02; items inside a folder that already existed stayed in place): the CLI in a terminal
would never see it, and uninstalling the app deletes it.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from .config import Settings
from .errors import ConfigError, LegacyDataNotMigrated, MigrationError

MARKER = "migration.json"
LEGACY_FOLDERS = ("data", "plans")  # checkout folder -> where its files go in the data dir
TARGETS = {"data": "", "plans": "plans"}

LegacyState = Literal["none", "not_migrated", "migrated"]


def legacy_files(root: Path | None) -> list[tuple[str, Path]]:
    """Files left in a checkout's `data/` and `plans/`, as (folder, path), sorted."""
    if root is None:
        return []
    found = []
    for folder in LEGACY_FOLDERS:
        base = root / folder
        if base.is_dir():
            found.extend((folder, p) for p in sorted(base.rglob("*")) if p.is_file())
    return found


def legacy_state(settings: Settings) -> LegacyState:
    if not legacy_files(settings.project_root):
        return "none"
    return "migrated" if (settings.data_dir / MARKER).is_file() else "not_migrated"


_PACKAGE_PRIVATE = re.compile(r"[\\/]Packages[\\/][^\\/]+[\\/]LocalCache[\\/]", re.IGNORECASE)


def _resolve(path: Path) -> str:
    return os.path.realpath(path)


def is_package_private(path: Path) -> bool:
    """Whether a path really lives in a Store app's private folder (only visible once it exists)."""
    return bool(_PACKAGE_PRIVATE.search(_resolve(path)))


def ensure_not_virtualized(data_dir: Path, what: str = "data directory", setting: str = "CURATUNE_DATA_DIR") -> None:
    """Create the folder if needed and make sure it is a real one. A folder this call created and found
    redirected is removed again (it is empty), so nothing is ever written there. Used for the data dir, and
    for the token dir before `auth_login` writes the token."""
    missing = [p for p in (data_dir, *data_dir.parents) if not p.exists()]
    data_dir.mkdir(parents=True, exist_ok=True)
    if not is_package_private(data_dir):
        return
    for p in missing:  # deepest first; only the empty folders this call made
        try:
            p.rmdir()
        except OSError:
            break
    code = "DATA_DIR_VIRTUALIZED" if setting == "CURATUNE_DATA_DIR" else "TOKEN_DIR_VIRTUALIZED"
    raise ConfigError(
        f"curatune's {what} would be a private folder of a Microsoft Store app: Windows redirects new folders "
        "under AppData for the programs such an app starts (Claude Desktop from the Store does this). curatune "
        f"in a terminal wouldn't see it, and uninstalling the app would delete it. Set {setting} to a folder "
        "outside AppData, such as one in Documents, or run curatune once from a terminal first.",
        code=code,
        details={"path": str(data_dir), "resolves_to": _resolve(data_dir)},
    )


def check(settings: Settings) -> list[dict[str, Any]]:
    """Run before any command that uses the data dir. Refuses a data dir private to a Store app
    (DATA_DIR_VIRTUALIZED); raises LEGACY_DATA_NOT_MIGRATED with the default data dir; returns the
    LEGACY_DATA_PRESENT warning with an explicit one."""
    if legacy_state(settings) != "not_migrated":
        ensure_not_virtualized(settings.data_dir)
        return []
    details = {"legacy_dirs": [str(settings.project_root / f) for f in LEGACY_FOLDERS], "data_dir": str(settings.data_dir)}
    if not settings.data_dir_explicit:
        # Before the data dir exists, so that `data migrate` finds it empty.
        raise LegacyDataNotMigrated(
            "curatune now keeps its data outside the repository, and this checkout's data/ and plans/ haven't "
            "been copied there yet. Run `curatune data migrate` (it copies, never moves), or set "
            "CURATUNE_DATA_DIR to choose another folder.",
            details=details,
        )
    ensure_not_virtualized(settings.data_dir)
    return [
        {
            "code": "LEGACY_DATA_PRESENT",
            "message": "This checkout's data/ and plans/ hold data that CURATUNE_DATA_DIR doesn't use. Run "
            "`curatune data migrate` to copy it there, if you want it.",
            **details,
        }
    ]


def status(settings: Settings) -> dict[str, Any]:
    """For `auth status`: where the data lives, and whether a checkout still holds older data."""
    return {
        "data_dir": str(settings.data_dir),
        "data_dir_explicit": settings.data_dir_explicit,
        "legacy_data": legacy_state(settings),
        "virtualized": settings.data_dir.exists() and is_package_private(settings.data_dir),
    }


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def migrate(settings: Settings, dry_run: bool = False) -> dict[str, Any]:
    root = settings.project_root
    files = legacy_files(root)
    if root is None or not files:
        raise MigrationError("There is nothing to migrate: no data/ or plans/ with files in a checkout.", code="NOTHING_TO_MIGRATE")
    data_dir = settings.data_dir
    if not dry_run:
        ensure_not_virtualized(data_dir)  # before anything is copied
    if (data_dir / MARKER).exists():
        raise MigrationError(
            "This data directory already holds a migration; nothing was copied.",
            code="ALREADY_MIGRATED",
            details={"data_dir": str(data_dir)},
        )
    plan = [(folder, src, data_dir / TARGETS[folder] / src.relative_to(root / folder)) for folder, src in files]
    conflicts = [str(dst) for _, _, dst in plan if dst.exists()]
    if conflicts:
        raise MigrationError(
            "Files already exist where the migration would copy; nothing was copied or overwritten.",
            code="MIGRATION_CONFLICT",
            details={"data_dir": str(data_dir), "existing": conflicts[:20], "count": len(conflicts)},
        )
    total_bytes = sum(src.stat().st_size for _, src, _ in plan)
    summary: dict[str, Any] = {
        "source": str(root),
        "data_dir": str(data_dir),
        "files": len(plan),
        "bytes": total_bytes,
        "by_folder": {f: sum(1 for folder, _, _ in plan if folder == f) for f in LEGACY_FOLDERS},
        "dry_run": dry_run,
    }
    if dry_run:
        summary["would_copy"] = [{"from": str(src), "to": str(dst)} for _, src, dst in plan]
        return summary

    stamp = f"{_now():%Y%m%dT%H%M%SZ}"
    backup_dir = data_dir / f"migration-backup-{stamp}"
    hashes: dict[str, str] = {}
    for folder, src, dst in plan:
        rel = src.relative_to(root).as_posix()
        hashes[rel] = _sha256(src)
        backup = backup_dir / rel
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, backup)
    for folder, src, dst in plan:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

    mismatched = [
        rel
        for folder, src, dst in plan
        if (rel := src.relative_to(root).as_posix())
        and not (_sha256(dst) == _sha256(backup_dir / rel) == hashes[rel] == _sha256(src))
    ]
    if mismatched:
        raise MigrationError(
            "Some copies don't match their originals, so the migration isn't marked done. The originals are "
            "untouched; check the data directory and run it again into an empty folder.",
            details={"data_dir": str(data_dir), "mismatched": mismatched[:20]},
        )
    marker = {
        "migrated_at": _now().isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": str(root),
        "backup": backup_dir.name,
        "files": hashes,
    }
    (data_dir / MARKER).write_text(json.dumps(marker, indent=2, ensure_ascii=False), encoding="utf-8")
    summary.update({"backup_dir": str(backup_dir), "verified": True, "originals_kept": True})
    return summary
