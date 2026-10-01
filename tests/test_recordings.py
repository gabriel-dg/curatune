import json

import pytest

from curatune import plans, recordings
from curatune.errors import InvalidArgument, PlanError
from curatune.recordings import RecordingStore

from .fakes import PLAYLIST_ID, FakeSpotify, track_uri


def entry(n, recorded, **extra):
    return {"uri": track_uri(n), "recorded": recorded, "confidence": "high", "source": "test", **extra}


@pytest.fixture
def store(tmp_path):
    return RecordingStore(tmp_path / "recordings.json")


@pytest.mark.parametrize("value", ["1947", "1947-12", "1947-12-05"])
def test_valid_recorded_formats(value):
    assert recordings.validate_recorded(value) == value


@pytest.mark.parametrize("value", ["47", "1947-13", "1947-02-30", "1947/12/05", None, 1947])
def test_invalid_recorded(value):
    with pytest.raises(InvalidArgument):
        recordings.validate_recorded(value)


def test_entry_requires_confidence_and_source():
    with pytest.raises(InvalidArgument):
        recordings.validate_entry({"uri": track_uri(1), "recorded": "1947", "confidence": "sure", "source": "x"})
    with pytest.raises(InvalidArgument):
        recordings.validate_entry({"uri": track_uri(1), "recorded": "1947", "confidence": "high", "source": " "})


def test_upsert_is_all_or_nothing(store):
    store.upsert([entry(1, "1945")])
    with pytest.raises(InvalidArgument):
        store.upsert([entry(2, "1946"), entry(3, "not-a-date")])
    assert set(store.load()) == {track_uri(1)}


def test_upsert_creates_and_updates(store):
    assert store.upsert([entry(1, "1945")])["created"] == 1
    result = store.upsert([entry(1, "1945-11-26", note="master"), entry(2, "1946")])
    assert (result["created"], result["updated"], result["total"]) == (1, 1, 2)
    assert result["skipped"] == []
    assert json.loads(store.path.read_text())[track_uri(1)]["note"] == "master"


def test_upsert_without_overwrite_keeps_stored_entries(store):
    store.upsert([entry(1, "1945-11-26", source="discography")])
    result = store.upsert([entry(1, "1950"), entry(2, "1946")], overwrite=False)
    assert (result["created"], result["updated"], result["skipped"], result["total"]) == (1, 0, [track_uri(1)], 2)
    stored = store.load()
    assert stored[track_uri(1)]["recorded"] == "1945-11-26" and stored[track_uri(1)]["source"] == "discography"


def test_upsert_without_overwrite_and_nothing_new_leaves_the_file_alone(store):
    store.upsert([entry(1, "1945")])
    before = store.path.stat().st_mtime_ns
    result = store.upsert([entry(1, "1950")], overwrite=False)
    assert (result["created"], result["skipped"]) == (0, [track_uri(1)])
    assert store.path.stat().st_mtime_ns == before


def test_upsert_repeated_uri_in_input_last_wins(store):
    result = store.upsert([entry(1, "1945"), entry(1, "1946")])
    assert (result["created"], result["updated"]) == (1, 0)
    assert store.load()[track_uri(1)]["recorded"] == "1946"


def test_chronological_order_is_stable_for_ties(store):
    items = [{"position": i, "uri": track_uri(i), "name": f"T{i}"} for i in range(4)]
    store.upsert([entry(0, "1947"), entry(1, "1945-11-26"), entry(2, "1945-11-26"), entry(3, "1939")])
    assert recordings.chronological_order(items, store.load()) == [3, 1, 2, 0]


def test_chronological_order_matches_by_isrc(store):
    store.upsert([entry(9, "1945", isrc="USX1"), entry(1, "1946")])
    items = [
        {"position": 0, "uri": track_uri(1), "name": "b"},
        {"position": 1, "uri": track_uri(5), "name": "a", "isrc": "USX1"},  # other edition, same recording
    ]
    assert recordings.chronological_order(items, store.load()) == [1, 0]


def test_missing_dates_are_reported(store):
    items = [{"position": i, "uri": track_uri(i), "name": f"T{i}"} for i in range(3)]
    store.upsert([entry(0, "1947")])
    with pytest.raises(PlanError) as exc:
        recordings.chronological_order(items, store.load())
    assert exc.value.code == "RECORDING_DATES_MISSING"
    assert [m["position"] for m in exc.value.details["missing"]] == [1, 2]


def test_reorder_plan_by_recording_date_applies(store, tmp_path):
    fake = FakeSpotify([track_uri(i) for i in range(4)])
    store.upsert([entry(0, "1949"), entry(1, "1945"), entry(2, "1947"), entry(3, "1939")])
    built = plans.build_reorder_plan(fake, PLAYLIST_ID, tmp_path, recordings=store)
    assert built["changes"]["new_order"] == [3, 1, 2, 0]
    assert fake.mutations == []
    plans.apply_plan(fake, tmp_path / f"{built['plan_id']}.json", tmp_path / "backups")
    assert fake.uris == [track_uri(3), track_uri(1), track_uri(2), track_uri(0)]


def test_already_chronological_is_no_changes(store, tmp_path):
    fake = FakeSpotify([track_uri(i) for i in range(2)])
    store.upsert([entry(0, "1940"), entry(1, "1941")])
    with pytest.raises(PlanError) as exc:
        plans.build_reorder_plan(fake, PLAYLIST_ID, tmp_path, recordings=store)
    assert exc.value.code == "NO_CHANGES"


def test_playlist_recordings_reports_missing_and_chronology(store):
    fake = FakeSpotify([track_uri(i) for i in range(3)])
    store.upsert([entry(0, "1940"), entry(2, "1939")])
    result = recordings.playlist_recordings(fake, store, PLAYLIST_ID)
    assert [m["position"] for m in result["missing"]] == [1]
    assert result["chronological"] is False
    assert result["items"][0]["matched_by"] == "uri"
