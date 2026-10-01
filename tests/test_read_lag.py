"""Snapshot read lag: reads return the pre-write snapshot_id for a while after a write."""

import pytest

from curatune import plans, playlists
from curatune.errors import SnapshotMismatch
from curatune.writelog import WriteLog

from .fakes import PLAYLIST_ID, FakeSpotify, track_uri


@pytest.fixture
def log(tmp_path):
    return WriteLog(tmp_path / "write_log.json")


def _lagging(log, n=4):
    return FakeSpotify([track_uri(i) for i in range(n)], lag=True, write_log=log)


def test_add_then_plan_then_apply_while_reads_lag(log, tmp_path):
    fake = _lagging(log)
    added = playlists.add_items(fake, PLAYLIST_ID, [track_uri(10)])

    state = playlists.get_playlist(fake, PLAYLIST_ID)
    assert state["playlist"]["snapshot_id"] == added["snapshot_id"]
    assert state["warnings"][0]["code"] == "SNAPSHOT_READ_LAG"

    built = plans.build_reorder_plan(fake, PLAYLIST_ID, tmp_path, move=(4, 0))
    assert built["playlist"]["snapshot_id"] == added["snapshot_id"]
    result = plans.apply_plan(fake, tmp_path / f"{built['plan_id']}.json", tmp_path / "backups")
    assert result["verified"] is True
    assert result["snapshot_id"] == fake.snapshot_id  # the write's snapshot, not the stale read


def test_plan_built_during_lag_still_applies_after_reads_converge(log, tmp_path):
    # The exact failure seen live: plan built during lag, applied after convergence.
    fake = _lagging(log)
    playlists.add_items(fake, PLAYLIST_ID, [track_uri(10)])
    built = plans.build_remove_plan(fake, PLAYLIST_ID, [0], tmp_path)
    fake.propagate()
    assert plans.apply_plan(fake, tmp_path / f"{built['plan_id']}.json", tmp_path / "backups")["verified"]


def test_without_write_log_lag_causes_mismatch(tmp_path):
    fake = _lagging(None)
    playlists.add_items(fake, PLAYLIST_ID, [track_uri(10)])
    built = plans.build_remove_plan(fake, PLAYLIST_ID, [0], tmp_path)
    fake.propagate()
    with pytest.raises(SnapshotMismatch):
        plans.apply_plan(fake, tmp_path / f"{built['plan_id']}.json", tmp_path / "backups")


def test_external_item_change_after_our_write_is_still_rejected(log, tmp_path):
    fake = _lagging(log)
    playlists.add_items(fake, PLAYLIST_ID, [track_uri(10)])
    built = plans.build_remove_plan(fake, PLAYLIST_ID, [0], tmp_path)
    fake.uris.append(track_uri(99))  # someone edits in the Spotify app
    fake.version += 1
    fake.mutations.clear()
    with pytest.raises(SnapshotMismatch) as exc:
        plans.apply_plan(fake, tmp_path / f"{built['plan_id']}.json", tmp_path / "backups")
    assert exc.value.details["items_changed"] is True
    assert fake.mutations == []


def test_stale_entries_expire(tmp_path):
    log = WriteLog(tmp_path / "write_log.json", ttl_seconds=-1)
    log.record(PLAYLIST_ID, "snap-new", ["a"])
    assert log.resolve(PLAYLIST_ID, "snap-old", ["a"]) == ("snap-old", False)


def test_entry_dropped_once_reads_converge(log):
    log.record(PLAYLIST_ID, "snap-new", ["a"])
    assert log.resolve(PLAYLIST_ID, "snap-old", ["a"]) == ("snap-new", True)
    assert log.resolve(PLAYLIST_ID, "snap-new", ["a"]) == ("snap-new", False)
    assert log.resolve(PLAYLIST_ID, "snap-old", ["a"]) == ("snap-old", False)


def test_market_reads_do_not_use_the_log(log):
    fake = _lagging(log)
    playlists.add_items(fake, PLAYLIST_ID, [track_uri(10)])
    state = playlists.get_playlist(fake, PLAYLIST_ID, market="AR")
    assert state["playlist"]["snapshot_id"] == "snap-1"


def _listed(fake):
    result = playlists.list_playlists(fake)
    [playlist] = [p for p in result["playlists"] if p["id"] == PLAYLIST_ID]
    return playlist["item_count"], result["warnings"]


def test_list_reports_the_count_our_write_left_while_the_list_lags(log):
    fake = _lagging(log)
    playlists.add_items(fake, PLAYLIST_ID, [track_uri(10), track_uri(11)])
    count, warnings = _listed(fake)
    assert count == 6  # the list itself still says 4
    assert warnings == [
        {
            "code": "ITEM_COUNT_READ_LAG",
            "message": warnings[0]["message"],
            "playlists": [{"playlist_id": PLAYLIST_ID, "listed_item_count": 4, "item_count": 6}],
        }
    ]


def test_list_needs_no_correction_once_it_agrees(log):
    fake = _lagging(log)
    playlists.add_items(fake, PLAYLIST_ID, [track_uri(10)])
    fake.propagate()
    assert _listed(fake) == (5, [])


def test_list_ignores_expired_entries(tmp_path):
    fake = _lagging(WriteLog(tmp_path / "write_log.json", ttl_seconds=-1))
    playlists.add_items(fake, PLAYLIST_ID, [track_uri(10)])
    assert _listed(fake) == (4, [])  # stale, but the entry is too old to vouch for anything


def test_list_without_write_log_reports_what_spotify_says():
    fake = _lagging(None)
    playlists.add_items(fake, PLAYLIST_ID, [track_uri(10)])
    assert _listed(fake) == (4, [])
