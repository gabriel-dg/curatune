"""Retention: plans and backups older than CURATUNE_RETENTION_DAYS are deleted; nothing else is touched."""

import os
import time

import pytest

from curatune import retention
from curatune.config import load_settings
from curatune.errors import ConfigError

PLAN_ID = "20260101T000000Z-reorder-AbCdEfGh-0a1b"
PLAYLIST_ID = "AbCdEfGhIjKlMnOpQrStUv"  # synthetic
DAY = 86400


@pytest.fixture
def settings(monkeypatch, tmp_path):
    monkeypatch.setenv("CURATUNE_PROJECT_DIR", str(tmp_path / "repo"))
    monkeypatch.setenv("CURATUNE_TOKEN_DIR", str(tmp_path / "tokens"))
    monkeypatch.delenv("CURATUNE_RETENTION_DAYS", raising=False)
    return load_settings()


def touch(path, days_old):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}", encoding="utf-8")
    stamp = time.time() - days_old * DAY
    os.utime(path, (stamp, stamp))
    return path


def test_old_plans_and_backups_go_recent_ones_and_other_files_stay(settings):
    old_plan = touch(settings.plans_dir / f"{PLAN_ID}.json", 91)
    new_plan = touch(settings.plans_dir / "20260301T000000Z-remove-AbCdEfGh-ffff.json", 10)
    old_backup = touch(settings.backups_dir / f"{PLAYLIST_ID}-20260101T000000Z-before-{PLAN_ID}.json", 200)
    foreign = touch(settings.plans_dir / "notes.json", 400)  # not a name curatune writes
    recordings = touch(settings.recordings_path, 400)  # the user's own data

    result = retention.prune(settings)

    assert result == {"retention_days": 90, "removed": {"plans": 1, "backups": 1}}
    assert not old_plan.exists() and not old_backup.exists()
    assert new_plan.exists() and foreign.exists() and recordings.exists()


def test_the_period_is_configurable(settings, monkeypatch):
    plan = touch(settings.plans_dir / f"{PLAN_ID}.json", 10)
    monkeypatch.setenv("CURATUNE_RETENTION_DAYS", "7")
    assert retention.prune(settings)["removed"]["plans"] == 1
    assert not plan.exists()


@pytest.mark.parametrize("value", ["0", "-3", "ninety"])
def test_invalid_periods_are_config_errors(settings, monkeypatch, value):
    monkeypatch.setenv("CURATUNE_RETENTION_DAYS", value)
    with pytest.raises(ConfigError):
        retention.prune(settings)


def test_missing_folders_are_fine(settings):
    assert retention.prune(settings)["removed"] == {"plans": 0, "backups": 0}
