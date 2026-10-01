"""Rename / description plans: built without touching Spotify, applied only if unchanged, verified."""

import json

import pytest

from curatune import _writes, plans
from curatune.errors import PlanError, SnapshotMismatch

from .fakes import PLAYLIST_ID, FakeSpotify, track_uri


@pytest.fixture
def fake():
    f = FakeSpotify([track_uri(i) for i in range(3)])
    f.name, f.description = "Old name", "Old description"
    return f


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(plans.time, "sleep", lambda s: None)


def build(fake, tmp_path, **kwargs):
    built = plans.build_details_plan(fake, PLAYLIST_ID, tmp_path, **kwargs)
    return built, tmp_path / f"{built['plan_id']}.json"


def test_plan_lists_only_changed_fields_and_touches_nothing(fake, tmp_path):
    built, path = build(fake, tmp_path, name="New name", description="Old description")
    assert fake.mutations == []
    assert built["changes"] == {"name": {"from": "Old name", "to": "New name"}}
    plan = json.loads(path.read_text())
    assert plan["kind"] == "details" and plan["operations"] == [{"op": "set_details", "fields": {"name": "New name"}}]


def test_apply_renames_and_redescribes_and_verifies(fake, tmp_path):
    _, path = build(fake, tmp_path, name="New name", description="Fans' favourites & deep cuts")
    result = plans.apply_plan(fake, path, tmp_path / "backups")
    assert result["verified"] is True and result["warnings"] == []
    assert (fake.name, fake.description) == ("New name", "Fans' favourites & deep cuts")
    # Only name/description are ever sent.
    assert fake.mutations == [("put", {"name": "New name", "description": "Fans' favourites & deep cuts"})]
    assert json.loads(path.read_text())["applied"]["verified"] is True


def test_description_is_compared_unescaped(fake, tmp_path):
    fake.description = "Rock & Roll's roots"  # served HTML-escaped by the fake, like Spotify does
    with pytest.raises(PlanError) as exc:
        build(fake, tmp_path, description="Rock & Roll's roots")
    assert exc.value.code == "NO_CHANGES"


def test_literal_null_description_reads_as_empty(fake, tmp_path):
    fake.description = "null"  # what Spotify returns for a playlist created without a description
    with pytest.raises(PlanError) as exc:
        build(fake, tmp_path, description="")
    assert exc.value.code == "NO_CHANGES"
    built, _ = build(fake, tmp_path, description="Set")
    assert built["changes"] == {"description": {"from": "", "to": "Set"}}


def test_apply_refuses_if_the_field_changed_meanwhile(fake, tmp_path):
    _, path = build(fake, tmp_path, description="Planned")
    fake.description = "Edited in the app"
    fake.mutations.clear()
    with pytest.raises(SnapshotMismatch):
        plans.apply_plan(fake, path, tmp_path / "backups")
    assert fake.mutations == []


def test_item_changes_do_not_block_a_details_plan(fake, tmp_path):
    _, path = build(fake, tmp_path, name="New name")
    fake.post("", {"uris": [track_uri(9)]})  # someone adds a track
    assert plans.apply_plan(fake, path, tmp_path / "backups")["verified"] is True


def test_ignored_change_is_reported_not_claimed(fake, tmp_path):
    fake.ignore_details = True
    _, path = build(fake, tmp_path, name="New name")
    result = plans.apply_plan(fake, path, tmp_path / "backups")
    assert result["verified"] is False
    assert result["warnings"][0]["code"] == "DETAILS_NOT_CONFIRMED"
    assert result["current"] == {"name": "Old name"}


def test_duplicate_name_warns(fake, tmp_path):
    fake.other_playlists = [{"id": "x" * 22, "name": "new NAME", "owner": {"id": "me"}}]
    built, _ = build(fake, tmp_path, name="New name")
    assert built["warnings"][0]["code"] == "DUPLICATE_NAME"


@pytest.mark.parametrize(
    "kwargs, code",
    [({}, "PLAN_INVALID"), ({"name": "  "}, "PLAN_INVALID"), ({"name": "Old name"}, "NO_CHANGES")],
)
def test_invalid_requests(fake, tmp_path, kwargs, code):
    with pytest.raises(PlanError) as exc:
        build(fake, tmp_path, **kwargs)
    assert exc.value.code == code


def test_visibility_cannot_be_smuggled_into_a_plan(fake, tmp_path):
    _, path = build(fake, tmp_path, name="New name")
    plan = json.loads(path.read_text())
    plan["before"]["public"], plan["after"]["public"] = True, False
    plan["operations"][0]["fields"]["public"] = False
    plan["changes"]["public"] = {"from": True, "to": False}
    plan["checksum"] = plans.plan_checksum(plan)  # a deliberate forgery, not an accidental edit
    path.write_text(json.dumps(plan))
    with pytest.raises(PlanError) as exc:
        plans.apply_plan(fake, path, tmp_path / "backups")
    assert exc.value.code == "PLAN_INCONSISTENT"
    assert fake.mutations == []


def test_set_details_rejects_other_fields(fake):
    with pytest.raises(ValueError):
        _writes.set_details(fake, PLAYLIST_ID, {"public": False})


def test_check_reports_applicability(fake, tmp_path):
    _, path = build(fake, tmp_path, description="Planned")
    assert plans.show_plan(path, fake)["check"]["applicable"] is True
    fake.description = "Edited in the app"
    check = plans.show_plan(path, fake)["check"]
    assert check["applicable"] is False and check["current"] == {"description": "Edited in the app"}
