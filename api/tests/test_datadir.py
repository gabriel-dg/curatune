"""Where curatune keeps its data, the guard against data left in a checkout, and `data migrate`.

No test touches the user's data: conftest points CURATUNE_DATA_DIR at tmp_path, and the tests of the
default location point LOCALAPPDATA / XDG_DATA_HOME there too.
"""

import json
import os

import pytest

from curatune import cli, config, datadir
from curatune.config import Settings, load_settings
from curatune.errors import ConfigError, LegacyDataNotMigrated, MigrationError


def clear_env(monkeypatch, *names):
    """Unset variables so that whatever load_dotenv() sets during the test is removed afterwards."""
    for name in names:
        monkeypatch.setenv(name, "x")
        monkeypatch.delenv(name)


@pytest.fixture
def checkout(tmp_path, monkeypatch):
    """A source checkout with data left in data/ and plans/, as before phase 3."""
    root = tmp_path / "repo"
    (root / "data" / "backups").mkdir(parents=True)
    (root / "plans").mkdir()
    (root / "data" / "recordings.json").write_text('{"spotify:track:x": {"recorded": "1945"}}', encoding="utf-8")
    (root / "data" / "write_log.json").write_text("{}", encoding="utf-8")
    (root / "data" / "backups" / "pl-before-plan.json").write_bytes(b'{"items": []}\n')
    (root / "plans" / "20260101T000000Z-remove-abcdefgh-0001.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("CURATUNE_PROJECT_DIR", str(root))
    monkeypatch.setenv("CURATUNE_TOKEN_DIR", str(tmp_path / "config"))
    clear_env(monkeypatch, "SPOTIFY_CLIENT_ID")
    return root


def settings_for(root, data_dir, explicit):
    return Settings(root, "cid", 8888, None, root.parent / "config", data_dir, data_dir_explicit=explicit)


# --- Where the data lives -----------------------------------------------------------------------------


def test_data_dir_defaults_next_to_the_token_on_windows(monkeypatch, tmp_path, checkout):
    monkeypatch.delenv("CURATUNE_DATA_DIR")
    monkeypatch.setattr(config.sys, "platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    s = load_settings()
    assert s.data_dir == tmp_path / "local" / "curatune" / "data" and s.data_dir_explicit is False
    assert s.plans_dir == s.data_dir / "plans" and s.recordings_path == s.data_dir / "recordings.json"


def test_data_dir_follows_xdg_elsewhere(monkeypatch, tmp_path, checkout):
    monkeypatch.delenv("CURATUNE_DATA_DIR")
    monkeypatch.setattr(config.sys, "platform", "linux")
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "share"))
    assert load_settings().data_dir == tmp_path / "share" / "curatune"


def test_an_explicit_data_dir_expands_variables(monkeypatch, tmp_path, checkout):
    monkeypatch.setenv("CURATUNE_TEST_BASE", str(tmp_path / "mine"))
    monkeypatch.setenv("CURATUNE_DATA_DIR", os.path.join("$CURATUNE_TEST_BASE", "curatune"))
    s = load_settings()
    assert s.data_dir == (tmp_path / "mine" / "curatune").resolve() and s.data_dir_explicit is True


def test_the_data_dir_may_not_live_in_a_checkout(monkeypatch, checkout):
    monkeypatch.setenv("CURATUNE_DATA_DIR", str(checkout / "somewhere"))
    with pytest.raises(ConfigError) as exc:
        load_settings()
    assert "data directory" in exc.value.message and "data_dir" in exc.value.details


def test_without_a_checkout_the_cwd_is_never_the_project(monkeypatch, tmp_path):
    # An installed server started in the home directory: the token dir is inside the cwd, and that's fine.
    home = tmp_path / "home"
    (home / "AppData").mkdir(parents=True)
    monkeypatch.chdir(home)
    monkeypatch.delenv("CURATUNE_PROJECT_DIR", raising=False)
    monkeypatch.setattr(config, "__file__", str(tmp_path / "site-packages" / "curatune" / "config.py"))
    monkeypatch.setenv("CURATUNE_TOKEN_DIR", str(home / "AppData" / "curatune"))
    s = load_settings()
    assert s.project_root is None and s.token_dir == (home / "AppData" / "curatune").resolve()


def test_env_files_checkout_first_then_config_dir_and_process_env_wins(monkeypatch, tmp_path, checkout):
    clear_env(monkeypatch, "SPOTIFY_REDIRECT_PORT", "CURATUNE_MARKET")
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / ".env").write_text(
        "SPOTIFY_CLIENT_ID=from-config\nSPOTIFY_REDIRECT_PORT=9001\nCURATUNE_MARKET=ar\n", encoding="utf-8"
    )
    (checkout / ".env").write_text("SPOTIFY_REDIRECT_PORT=9002\n", encoding="utf-8")
    monkeypatch.setenv("CURATUNE_MARKET", "us")
    s = load_settings()
    assert (s.client_id, s.redirect_port, s.market) == ("from-config", 9002, "US")


# --- The guard ----------------------------------------------------------------------------------------


def test_default_dir_with_unmigrated_data_blocks(checkout, tmp_path):
    s = settings_for(checkout, tmp_path / "data-dir", explicit=False)
    assert datadir.legacy_state(s) == "not_migrated"
    with pytest.raises(LegacyDataNotMigrated) as exc:
        datadir.check(s)
    assert "curatune data migrate" in exc.value.message


def test_explicit_dir_with_unmigrated_data_warns(checkout, tmp_path):
    [warning] = datadir.check(settings_for(checkout, tmp_path / "data-dir", explicit=True))
    assert warning["code"] == "LEGACY_DATA_PRESENT"


def test_empty_legacy_folders_or_no_checkout_mean_nothing_to_guard(tmp_path):
    root = tmp_path / "repo"
    (root / "data" / "backups").mkdir(parents=True)
    (root / "plans").mkdir()
    assert datadir.check(settings_for(root, tmp_path / "d", explicit=False)) == []
    no_checkout = Settings(None, "cid", 8888, None, tmp_path / "c", tmp_path / "d", data_dir_explicit=False)
    assert datadir.check(no_checkout) == [] and datadir.legacy_state(no_checkout) == "none"


# --- data migrate ----------------------------------------------------------------------------------


def test_dry_run_copies_nothing(checkout, tmp_path):
    s = settings_for(checkout, tmp_path / "data-dir", explicit=False)
    result = datadir.migrate(s, dry_run=True)
    assert result["files"] == 4 and result["by_folder"] == {"data": 3, "plans": 1} and result["dry_run"] is True
    assert {"from": str(checkout / "plans" / "20260101T000000Z-remove-abcdefgh-0001.json"),
            "to": str(tmp_path / "data-dir" / "plans" / "20260101T000000Z-remove-abcdefgh-0001.json")} in result["would_copy"]  # fmt: skip
    assert not (tmp_path / "data-dir").exists()


def test_migrate_backs_up_copies_verifies_and_leaves_the_originals(checkout, tmp_path):
    s = settings_for(checkout, tmp_path / "data-dir", explicit=False)
    before = {p: p.read_bytes() for p in checkout.rglob("*") if p.is_file()}
    result = datadir.migrate(s)
    assert result["verified"] is True and result["files"] == 4 and result["originals_kept"] is True
    d = tmp_path / "data-dir"
    assert (d / "recordings.json").read_bytes() == (checkout / "data" / "recordings.json").read_bytes()
    assert (d / "backups" / "pl-before-plan.json").read_bytes() == b'{"items": []}\n'
    assert (d / "plans" / "20260101T000000Z-remove-abcdefgh-0001.json").exists()
    backup = d / result["backup_dir"].rsplit(os.sep, 1)[-1]
    assert backup.name.startswith("migration-backup-") and (backup / "data" / "recordings.json").exists()
    assert (backup / "plans" / "20260101T000000Z-remove-abcdefgh-0001.json").exists()
    marker = json.loads((d / "migration.json").read_text(encoding="utf-8"))
    assert set(marker["files"]) == {"data/recordings.json", "data/write_log.json", "data/backups/pl-before-plan.json",
                                    "plans/20260101T000000Z-remove-abcdefgh-0001.json"}  # fmt: skip
    assert {p: p.read_bytes() for p in checkout.rglob("*") if p.is_file()} == before  # never moves
    assert datadir.legacy_state(s) == "migrated" and datadir.check(s) == []  # unblocked, and no warning


def test_migrate_refuses_to_overwrite_and_copies_nothing(checkout, tmp_path):
    d = tmp_path / "data-dir"
    d.mkdir()
    (d / "recordings.json").write_text("{}", encoding="utf-8")
    with pytest.raises(MigrationError) as exc:
        datadir.migrate(settings_for(checkout, d, explicit=False))
    assert exc.value.code == "MIGRATION_CONFLICT" and exc.value.details["count"] == 1
    assert sorted(p.name for p in d.iterdir()) == ["recordings.json"]


def test_migrate_runs_once(checkout, tmp_path):
    s = settings_for(checkout, tmp_path / "data-dir", explicit=False)
    datadir.migrate(s)
    with pytest.raises(MigrationError) as exc:
        datadir.migrate(s)
    assert exc.value.code == "ALREADY_MIGRATED"


def test_nothing_to_migrate(tmp_path):
    with pytest.raises(MigrationError) as exc:
        datadir.migrate(Settings(None, "cid", 8888, None, tmp_path / "c", tmp_path / "d"))
    assert exc.value.code == "NOTHING_TO_MIGRATE"


# --- Through the CLI --------------------------------------------------------------------------------


def run(capsys, argv):
    code = cli.main(argv)
    return code, json.loads(capsys.readouterr().out)


def test_cli_blocks_until_migrated_then_works(monkeypatch, capsys, checkout, tmp_path):
    monkeypatch.delenv("CURATUNE_DATA_DIR")
    monkeypatch.setattr(config.sys, "platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setattr(cli, "_client", lambda s: pytest.fail("no command may reach Spotify while blocked"))

    code, out = run(capsys, ["recordings", "show", "pl"])
    assert code == 1 and out["error"]["code"] == "LEGACY_DATA_NOT_MIGRATED"
    code, out = run(capsys, ["auth", "status"])  # reports, never blocks
    assert code == 0 and out["data"]["data"]["legacy_data"] == "not_migrated"

    code, out = run(capsys, ["data", "migrate"])
    assert code == 0 and out["data"]["verified"] is True
    assert (tmp_path / "local" / "curatune" / "data" / "recordings.json").exists()
    code, out = run(capsys, ["auth", "status"])
    assert out["data"]["data"]["legacy_data"] == "migrated"


def test_cli_warns_with_an_explicit_dir(monkeypatch, capsys, checkout, tmp_path):
    monkeypatch.setattr(cli, "_client", lambda s: object())
    monkeypatch.setattr(cli.recordings, "playlist_recordings", lambda client, store, ref: {"items": [], "missing": []})
    code, out = run(capsys, ["recordings", "show", "pl"])
    assert code == 0 and [w["code"] for w in out["warnings"]] == ["LEGACY_DATA_PRESENT"]


# --- A data dir private to a packaged (MSIX) app -------------------------------------------------


@pytest.fixture
def store_app(monkeypatch, tmp_path):
    """Make every path under tmp_path/"local" look redirected, as Windows does for programs a packaged app
    starts (seen live 2026-10-02 with Claude Desktop, an MSIX package)."""
    real = datadir._resolve
    local = str(tmp_path / "local")

    def resolve(path):
        resolved = real(path)
        if resolved.startswith(local):
            return resolved.replace(local, str(tmp_path / "Packages" / "Claude_x" / "LocalCache" / "Local"), 1)
        return resolved

    monkeypatch.setattr(datadir, "_resolve", resolve)
    return tmp_path / "local"


def test_a_redirected_data_dir_is_refused_and_left_unmade(store_app, tmp_path):
    s = Settings(None, "cid", 8888, None, tmp_path / "c", store_app / "curatune" / "data")
    with pytest.raises(ConfigError) as exc:
        datadir.check(s)
    assert exc.value.code == "DATA_DIR_VIRTUALIZED" and "CURATUNE_DATA_DIR" in exc.value.message
    assert "Packages" in exc.value.details["resolves_to"]
    assert not store_app.exists()  # the folders it had to create are removed again


def test_migrate_refuses_a_redirected_data_dir_before_copying(store_app, checkout):
    s = settings_for(checkout, store_app / "curatune" / "data", explicit=False)
    assert datadir.migrate(s, dry_run=True)["files"] == 4  # a dry run writes nothing, so it can still list
    with pytest.raises(ConfigError) as exc:
        datadir.migrate(s)
    assert exc.value.code == "DATA_DIR_VIRTUALIZED" and not store_app.exists()


def test_status_reports_a_redirected_data_dir_without_failing(store_app, tmp_path):
    (store_app / "curatune" / "data").mkdir(parents=True)
    s = Settings(None, "cid", 8888, None, tmp_path / "c", store_app / "curatune" / "data")
    assert datadir.status(s)["virtualized"] is True


def test_a_real_data_dir_passes(tmp_path):
    s = Settings(None, "cid", 8888, None, tmp_path / "c", tmp_path / "data")
    assert datadir.check(s) == [] and (tmp_path / "data").is_dir() and datadir.status(s)["virtualized"] is False
