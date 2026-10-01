import json
import random

import pytest

from curatune import plans
from curatune.errors import PlanError, SnapshotMismatch

from .fakes import PLAYLIST_ID, FakeSpotify, track_uri

# --- Pure helpers -----------------------------------------------------------------------------


@pytest.mark.parametrize("seed", range(200))
def test_compute_moves_reaches_any_permutation(seed):
    rng = random.Random(seed)
    n = rng.randint(1, 60)
    new_order = list(range(n))
    rng.shuffle(new_order)
    ops = plans.compute_moves(new_order)
    assert plans.simulate(list(range(n)), ops) == new_order


def test_compute_moves_bebop_shape_uses_at_most_one_move_per_late_addition():
    # 31 items in order, then 10 late additions that belong at scattered earlier positions.
    targets = [2, 5, 9, 12, 16, 20, 23, 26, 28, 30]
    order = list(range(31))
    for offset, target in enumerate(targets):
        order.insert(target + offset, 31 + offset)
    ops = plans.compute_moves(order)
    assert plans.simulate(list(range(41)), ops) == order
    assert len(ops) <= 10


def test_compute_moves_rotation_is_single_block_move():
    ops = plans.compute_moves([1, 2, 3, 4, 0])
    assert ops == [{"op": "move", "range_start": 1, "insert_before": 0, "range_length": 4}]


def test_simulate_move_down_matches_spotify_semantics():
    # Spotify: insert_before refers to positions before the move.
    assert plans.simulate(list("abcde"), [{"op": "move", "range_start": 0, "insert_before": 3, "range_length": 1}]) == list("bcade")


def test_remove_operations_reinsert_kept_duplicates():
    a, b, c = track_uri(1), track_uri(2), track_uri(3)
    before = [a, b, a, c, a]
    ops = plans.compute_remove_operations(before, {2})
    assert ops[0] == {"op": "delete_uris", "uris": [a]}
    assert plans.simulate(before, ops) == [a, b, c, a]


def test_parse_positions_and_ranges():
    assert plans.parse_positions("3, 17,20-22") == [3, 17, 20, 21, 22]
    with pytest.raises(PlanError):
        plans.parse_positions("5-2")


def test_order_from_move():
    assert plans.order_from_move(5, 4, 1) == [0, 4, 1, 2, 3]
    with pytest.raises(PlanError):
        plans.order_from_move(5, 5, 0)


# --- Build / apply flow against the fake API --------------------------------------------------


@pytest.fixture
def fake():
    return FakeSpotify([track_uri(i) for i in range(8)])


def test_reorder_plan_does_not_mutate_and_apply_verifies(fake, tmp_path):
    new_order = [0, 6, 1, 2, 7, 3, 4, 5]
    built = plans.build_reorder_plan(fake, PLAYLIST_ID, tmp_path / "plans", new_order=new_order, reason="test")
    assert fake.mutations == []
    path = tmp_path / "plans" / f"{built['plan_id']}.json"
    assert path.exists()

    result = plans.apply_plan(fake, path, tmp_path / "backups")
    assert result["verified"] is True
    assert fake.uris == [track_uri(i) for i in new_order]
    assert len(list((tmp_path / "backups").glob("*.json"))) == 1
    assert json.loads(path.read_text())["applied"]["verified"] is True


def test_apply_aborts_when_playlist_changed(fake, tmp_path):
    built = plans.build_remove_plan(fake, PLAYLIST_ID, [1], tmp_path)
    fake.post("", {"uris": [track_uri(99)]})  # someone edits the playlist
    fake.mutations.clear()
    with pytest.raises(SnapshotMismatch):
        plans.apply_plan(fake, tmp_path / f"{built['plan_id']}.json", tmp_path / "backups")
    assert fake.mutations == []


def test_apply_rejects_tampered_plan(fake, tmp_path):
    built = plans.build_remove_plan(fake, PLAYLIST_ID, [1], tmp_path)
    path = tmp_path / f"{built['plan_id']}.json"
    plan = json.loads(path.read_text())
    plan["operations"][0]["uris"] = [track_uri(5)]
    path.write_text(json.dumps(plan))
    with pytest.raises(PlanError) as exc:
        plans.apply_plan(fake, path, tmp_path / "backups")
    assert exc.value.code == "PLAN_CHECKSUM_MISMATCH"
    assert fake.mutations == []


def _tamper(path, mutate):
    plan = json.loads(path.read_text())
    mutate(plan)
    path.write_text(json.dumps(plan))


@pytest.mark.parametrize(
    "mutate",
    [
        # Shows removing position 3 while the operations remove position 1.
        lambda p: p["changes"]["remove"][0].update(position=3, uri=p["before"][3]["uri"]),
        # Claims an extra removal.
        lambda p: p["changes"]["remove"].append({**p["before"][5]}),
        # after no longer traces back to before.
        lambda p: p["after"][0].update(from_position=4),
    ],
)
def test_remove_plan_description_must_match_operations(fake, tmp_path, mutate):
    built = plans.build_remove_plan(fake, PLAYLIST_ID, [1], tmp_path)
    path = tmp_path / f"{built['plan_id']}.json"
    _tamper(path, mutate)
    with pytest.raises(PlanError) as exc:
        plans.apply_plan(fake, path, tmp_path / "backups")
    assert exc.value.code == "PLAN_INCONSISTENT"
    assert fake.mutations == []


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p["changes"].update(new_order=list(range(len(p["before"])))),
        lambda p: p["changes"]["moves"][0].update(insert_before=7),
    ],
)
def test_reorder_plan_description_must_match_operations(fake, tmp_path, mutate):
    built = plans.build_reorder_plan(fake, PLAYLIST_ID, tmp_path, new_order=[7, 0, 1, 2, 3, 4, 5, 6])
    path = tmp_path / f"{built['plan_id']}.json"
    _tamper(path, mutate)
    with pytest.raises(PlanError) as exc:
        plans.apply_plan(fake, path, tmp_path / "backups")
    assert exc.value.code == "PLAN_INCONSISTENT"
    assert fake.mutations == []


def test_apply_twice_is_refused(fake, tmp_path):
    built = plans.build_remove_plan(fake, PLAYLIST_ID, [0], tmp_path)
    path = tmp_path / f"{built['plan_id']}.json"
    plans.apply_plan(fake, path, tmp_path / "backups")
    with pytest.raises(PlanError) as exc:
        plans.apply_plan(fake, path, tmp_path / "backups")
    assert exc.value.code == "PLAN_ALREADY_APPLIED"


def test_remove_one_occurrence_of_duplicated_uri(tmp_path):
    a, b = track_uri(1), track_uri(2)
    fake = FakeSpotify([a, b, a, b])
    built = plans.build_remove_plan(fake, PLAYLIST_ID, [2], tmp_path)
    assert built["warnings"][0]["code"] == "REINSERTED_DUPLICATES"
    result = plans.apply_plan(fake, tmp_path / f"{built['plan_id']}.json", tmp_path / "backups")
    assert result["verified"] is True
    assert fake.uris == [a, b, b]


def test_identity_reorder_is_rejected(fake, tmp_path):
    with pytest.raises(PlanError) as exc:
        plans.build_reorder_plan(fake, PLAYLIST_ID, tmp_path, new_order=list(range(8)))
    assert exc.value.code == "NO_CHANGES"


def test_plans_refuse_playlists_not_owned(tmp_path):
    fake = FakeSpotify([track_uri(1), track_uri(2)], owner_id="someone-else")
    with pytest.raises(Exception) as exc:
        plans.build_remove_plan(fake, PLAYLIST_ID, [0], tmp_path)
    assert getattr(exc.value, "code", None) == "FORBIDDEN"
