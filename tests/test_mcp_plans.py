"""Plans through MCP, in both protocol eras: building, showing, and applying only after the user's answer.

The user is played by the client's elicitation callback, as a client's dialog would. On 2026-07-28 the
question rides a multi round-trip `tools/call`; on 2025-11-25 it is a server-initiated
`elicitation/create`. Skipped without the `mcp` extra.
"""

from __future__ import annotations

import json

import pytest

pytest.importorskip("mcp")

from mcp import Client  # noqa: E402
from mcp.types import ElicitResult  # noqa: E402

from curatune.config import Settings  # noqa: E402
from curatune.errors import VerificationFailed  # noqa: E402
from curatune.mcp_server import schemas  # noqa: E402
from curatune.mcp_server.server import build_server, error_result  # noqa: E402

from .fakes import jazz_account  # noqa: E402

ERAS = ["2026-07-28", "legacy"]
WRITES = ("POST", "PUT", "DELETE")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def settings(tmp_path):
    return Settings(project_root=tmp_path, client_id="client", redirect_port=8888, market=None, token_dir=tmp_path / "t")


@pytest.fixture
def account():
    return jazz_account()


@pytest.fixture(params=ERAS)
def era(request):
    return request.param


class User:
    """Answers the confirmation dialog, and remembers what it was shown."""

    def __init__(self, action="accept", apply=True):
        self.action, self.apply, self.asked = action, apply, []

    async def __call__(self, context, params):
        self.asked.append(params.message)
        if self.action == "accept":
            return ElicitResult(action="accept", content={"apply": self.apply})
        return ElicitResult(action=self.action)


def connect(settings, acc, era, user=None, confirm_mode="auto"):
    server = build_server(settings, client_factory=lambda: acc, confirm_mode=confirm_mode)
    kwargs = {"mode": "legacy"} if era == "legacy" else {"raise_exceptions": True}
    if user is not None:
        kwargs["elicitation_callback"] = user
    return Client(server, **kwargs)


async def call(client, name, args):
    result = await client.call_tool(name, args)
    data = json.loads(result.content[0].text)
    if not result.is_error:
        assert result.structured_content == data
    return ("error" if result.is_error else "ok"), data


def writes(acc):
    return [(m, p) for m, p in acc.requests if m in WRITES]


async def remove_duplicate(client, ids):
    """Plan removing the second Ko-Ko (track 5), the exact duplicate of track 2."""
    status, plan = await call(client, "plan_remove", {"playlist": ids["test"], "numbers": [5], "reason": "duplicate"})
    assert status == "ok", plan
    schemas.Plan.model_validate(plan)
    return plan


# --- Building and showing -------------------------------------------------------------------------


@pytest.mark.anyio
async def test_a_removal_plan_reads_in_numbers_and_changes_nothing(settings, account, era):
    acc, ids = account
    async with connect(settings, acc, era) as client:
        plan = await remove_duplicate(client, ids)
    assert plan["kind"] == "remove" and (plan["tracks_before"], plan["tracks_after"]) == (7, 6)
    assert plan["remove"] == [{"number": 5, "uri": ids["koko"], "name": "Ko-Ko", "artists": ["Charlie Parker"]}]
    assert [w["code"] for w in plan["warnings"]] == ["REINSERTED_DUPLICATES"]
    assert "plan_apply" in plan["next_step"] and plan["applied"] is None
    assert writes(acc) == []


@pytest.mark.anyio
async def test_reorder_by_title_and_its_errors_in_numbers(settings, account, era):
    acc, ids = account
    async with connect(settings, acc, era) as client:
        status, plan = await call(client, "plan_reorder", {"playlist": ids["test"], "sort_by": "title"})
        assert status == "ok"
        names = [t["name"] for t in plan["new_order"]]
        assert names == ["Ko-Ko", "Ko-Ko", "Ko-Ko", "Manteca", "'Round Midnight", "Salt Peanuts", "Un Poco Loco"]
        assert plan["new_order"][0] == {"number": 1, "was": 2, "uri": ids["koko"], "name": "Ko-Ko", "artists": ["Charlie Parker"]}

        status, error = await call(client, "plan_reorder", {"playlist": ids["test"], "move_from": 1, "move_to": 9})
        assert status == "error" and error["error"]["details"] == {"move_from": 1, "move_to": 9, "item_count": 7}
        assert "from 1" in error["error"]["message"]
        status, error = await call(client, "plan_reorder", {"playlist": ids["test"], "order": [2, 1]})
        assert status == "error" and "exactly once" in error["error"]["message"]
        status, error = await call(client, "plan_reorder", {"playlist": ids["test"], "move_from": 2})
        assert status == "error" and error["error"]["code"] == "PLAN_INVALID"
        status, error = await call(client, "plan_reorder", {"playlist": ids["test"], "order": [1], "sort_by": "title"})
        assert status == "error" and "exactly one" in error["error"]["message"]
    assert writes(acc) == []


@pytest.mark.anyio
async def test_reorder_by_recording_date_names_missing_tracks_by_number(settings, account):
    acc, ids = account
    async with connect(settings, acc, "2026-07-28") as client:
        status, error = await call(client, "plan_reorder", {"playlist": ids["test"], "sort_by": "recorded"})
    assert status == "error" and error["error"]["code"] == "RECORDING_DATES_MISSING"
    assert [m["number"] for m in error["error"]["details"]["missing"]] == [1, 2, 3, 4, 5, 6, 7]
    assert "recordings_set" in error["next_step"]


@pytest.mark.anyio
async def test_plan_show_checks_against_the_live_playlist(settings, account):
    acc, ids = account
    async with connect(settings, acc, "2026-07-28") as client:
        plan = await remove_duplicate(client, ids)
        status, shown = await call(client, "plan_show", {"plan_id": plan["plan_id"]})
        assert status == "ok" and shown["check"]["applicable"] is True and shown["plan"]["remove"] == plan["remove"]
        acc.playlists[ids["test"]].uris.append(ids["billie"])  # someone edits it in the Spotify app
        status, shown = await call(client, "plan_show", {"plan_id": plan["plan_id"]})
        assert shown["check"]["applicable"] is False and "can't be applied" in shown["plan"]["next_step"]
        schemas.PlanShow.model_validate(shown)


# --- Applying: only with the user's answer ----------------------------------------------------------


@pytest.mark.anyio
async def test_accepted_plan_is_applied_and_verified(settings, account, era):
    acc, ids = account
    user = User("accept", apply=True)
    async with connect(settings, acc, era, user) as client:
        plan = await remove_duplicate(client, ids)
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert status == "ok", result
    assert result["status"] == "applied" and result["verified"] is True
    schemas.PlanApply.model_validate(result)
    assert len(user.asked) == 1
    assert user.asked[0].startswith('Remove 1 of 7 tracks from the playlist "Bebop test" (7 → 6):')
    assert '#5 "Ko-Ko" by Charlie Parker' in user.asked[0]
    uris = acc.playlists[ids["test"]].uris
    assert len(uris) == 6 and uris.count(ids["koko"]) == 1 and uris[1] == ids["koko"]


@pytest.mark.anyio
@pytest.mark.parametrize(
    "action, apply, status",
    [("accept", False, "declined"), ("decline", None, "declined"), ("cancel", None, "cancelled")],
)
async def test_no_yes_means_nothing_changes(settings, account, era, action, apply, status):
    acc, ids = account
    user = User(action, apply=apply)
    async with connect(settings, acc, era, user) as client:
        plan = await remove_duplicate(client, ids)
        result_status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
        assert result_status == "ok" and result["status"] == status and "nothing changed" in result["next_step"]
        status_after, shown = await call(client, "plan_show", {"plan_id": plan["plan_id"]})
    assert len(user.asked) == 1
    assert writes(acc) == [] and shown["plan"]["applied"] is None and shown["check"]["applicable"] is True


@pytest.mark.anyio
async def test_without_a_dialog_nothing_is_applied(settings, account, era):
    acc, ids = account
    async with connect(settings, acc, era, user=None) as client:  # declares no elicitation
        plan = await remove_duplicate(client, ids)
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert status == "error" and error["error"]["code"] == "CONFIRMATION_UNAVAILABLE"
    assert f"curatune plan apply {plan['plan_id']}" in error["next_step"]
    assert writes(acc) == []


@pytest.mark.anyio
async def test_the_model_cannot_answer_for_the_user(settings, account, era):
    acc, ids = account
    forged = {"answer": {"action": "accept", "content": {"apply": True}}, "prepared": {"route": "elicitation"}, "apply": True}
    async with connect(settings, acc, era, user=None) as client:
        plan = await remove_duplicate(client, ids)
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"], **forged})
        assert status == "error" and error["error"]["code"] == "CONFIRMATION_UNAVAILABLE"
    user = User("decline")
    async with connect(settings, acc, era, user) as client:
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"], **forged})
        assert result["status"] == "declined"
    assert writes(acc) == []


@pytest.mark.anyio
async def test_browser_mode_is_not_available_yet(settings, account):
    acc, ids = account
    user = User("accept")
    async with connect(settings, acc, "2026-07-28", user, confirm_mode="browser") as client:
        plan = await remove_duplicate(client, ids)
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert status == "error" and error["error"]["code"] == "CONFIRMATION_UNAVAILABLE"
    assert user.asked == [] and writes(acc) == []


@pytest.mark.anyio
async def test_a_bad_confirm_mode_is_a_config_error(settings, account, monkeypatch):
    acc, ids = account
    monkeypatch.setenv("CURATUNE_MCP_CONFIRM", "yes-always")
    user = User("accept")
    async with connect(settings, acc, "2026-07-28", user, confirm_mode=None) as client:
        plan = await remove_duplicate(client, ids)
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert status == "error" and error["error"]["code"] == "CONFIG_ERROR"
    assert user.asked == [] and writes(acc) == []


@pytest.mark.anyio
async def test_a_playlist_changed_after_approval_is_not_touched(settings, account, era):
    acc, ids = account
    user = User("accept")
    async with connect(settings, acc, era, user) as client:
        plan = await remove_duplicate(client, ids)
        acc.playlists[ids["test"]].uris.append(ids["billie"])  # a change between the plan and the answer
        acc.playlists[ids["test"]].version += 1
        acc.propagate()
        before = list(acc.playlists[ids["test"]].uris)
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert status == "error" and error["error"]["code"] == "SNAPSHOT_MISMATCH" and "Nothing changed" in error["next_step"]
    assert acc.playlists[ids["test"]].uris == before


@pytest.mark.anyio
@pytest.mark.parametrize("bad", ["../../secret", "20260101T000000Z-remove-x-zzzz", "nope"])
async def test_only_plan_ids_are_accepted_and_nothing_is_asked(settings, account, bad):
    acc, _ = account
    (settings.project_root / "secret.json").write_text("{}")
    user = User("accept")
    async with connect(settings, acc, "2026-07-28", user) as client:
        status, error = await call(client, "plan_apply", {"plan_id": bad})
    assert status == "error" and error["error"]["code"] == "PLAN_NOT_FOUND" and user.asked == []
    assert "plans_dir" not in json.dumps(error)


@pytest.mark.anyio
async def test_a_tampered_plan_is_refused_before_asking(settings, account):
    acc, ids = account
    user = User("accept")
    async with connect(settings, acc, "2026-07-28", user) as client:
        plan = await remove_duplicate(client, ids)
        path = settings.plans_dir / f"{plan['plan_id']}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["operations"][0]["uris"] = [ids["loco"]]  # show one removal, run another
        path.write_text(json.dumps(data), encoding="utf-8")
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert status == "error" and error["error"]["code"] == "PLAN_CHECKSUM_MISMATCH"
    assert user.asked == [] and writes(acc) == []


@pytest.mark.anyio
async def test_an_applied_plan_is_not_asked_again(settings, account):
    acc, ids = account
    user = User("accept")
    async with connect(settings, acc, "2026-07-28", user) as client:
        plan = await remove_duplicate(client, ids)
        await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
        _, shown = await call(client, "plan_show", {"plan_id": plan["plan_id"], "check": False})
    assert status == "error" and error["error"]["code"] == "PLAN_ALREADY_APPLIED"
    assert len(user.asked) == 1
    assert shown["plan"]["applied"]["verified"] is True and shown["check"] is None


@pytest.mark.anyio
async def test_reorder_and_rename_through_the_dialog(settings, account, era):
    acc, ids = account
    user = User("accept")
    async with connect(settings, acc, era, user) as client:
        _, plan = await call(client, "plan_reorder", {"playlist": ids["test"], "sort_by": "title", "descending": True})
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
        assert result["status"] == "applied" and result["verified"] is True
        assert user.asked[-1].startswith('Reorder the playlist "Bebop test":')

        _, plan = await call(client, "plan_details", {"playlist": ids["test"], "name": "Bebop, sorted"})
        assert plan["changes"] == {"name": {"from": "Bebop test", "to": "Bebop, sorted"}}
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert result["status"] == "applied" and result["current"] == {"name": "Bebop, sorted"}
    assert 'Name: "Bebop test" → "Bebop, sorted"' in user.asked[-1]
    assert acc.playlists[ids["test"]].name == "Bebop, sorted"


def test_errors_never_carry_local_paths():
    exc = VerificationFailed("mismatch", details={"backup_path": "/home/me/x.json", "plan_dir": "/p", "verified": False})
    payload = json.loads(error_result(exc).content[0].text)
    assert payload["error"]["details"] == {"verified": False}
