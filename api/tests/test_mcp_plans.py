"""Plans through MCP, in both protocol eras: building, showing, and applying only after the user's answer.

The user is played by the client's elicitation callback, as a client's dialog would. On 2026-07-28 the
question rides a multi round-trip `tools/call`; on 2025-11-25 it is a server-initiated
`elicitation/create`. Skipped without the `mcp` extra.
"""

from __future__ import annotations

import http.client
import json
import re
import webbrowser
from urllib.parse import urlencode, urlsplit

import pytest

pytest.importorskip("mcp")

from mcp import Client  # noqa: E402
from mcp.types import ElicitResult  # noqa: E402

from curatune.config import Settings  # noqa: E402
from curatune.errors import VerificationFailed  # noqa: E402
from curatune.mcp_server import confirm, schemas  # noqa: E402
from curatune.mcp_server.server import build_server, error_result  # noqa: E402

from .fakes import jazz_account  # noqa: E402

ERAS = ["2026-07-28", "legacy"]
WRITES = ("POST", "PUT", "DELETE")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def settings(tmp_path):
    return Settings(project_root=None, data_dir=tmp_path / "data", client_id="client", redirect_port=8888, market=None, token_dir=tmp_path / "t")


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


class Browser:
    """Stands in for the user's browser: remembers each URL curatune opens, and acts on the page like a
    person would (same Host and Origin as the real browser)."""

    def __init__(self, works=True):
        self.works, self.urls = works, []

    def __call__(self, url):
        if self.works == "raises":
            raise webbrowser.Error("no runnable browser")
        self.urls.append(url)
        return self.works

    def page(self):
        return Page(self.urls[-1])


class Page:
    def __init__(self, url):
        parsed = urlsplit(url)
        self.host, self.port, self.path = parsed.hostname, parsed.port, parsed.path
        self.token = self.path.rsplit("/", 1)[1]
        self.text = self._request("GET", self.path)

    def _request(self, method, path, form=None):
        conn = http.client.HTTPConnection(self.host, self.port, timeout=5)
        headers = {"Host": f"{self.host}:{self.port}"}
        body = None
        if form is not None:
            body = urlencode(form)
            headers.update({"Origin": f"http://{self.host}:{self.port}", "Content-Type": "application/x-www-form-urlencoded"})
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        text = resp.read().decode("utf-8")
        conn.close()
        if method == "POST":  # the page answers Approve and Reject with a redirect to itself, as browsers follow
            assert resp.status == 303 and resp.getheader("Location") == self.path, (resp.status, text)
            return self._request("GET", self.path)
        assert resp.status == 200, (resp.status, text)
        return text

    def _nonce(self):
        return re.search(r'name="nonce" value="([^"]+)"', self.text).group(1)

    def approve(self):
        text = self._request("POST", self.path + "/approve", {"nonce": self._nonce()})
        return re.search(r'<p class="code">([^<]+)</p>', text).group(1)

    def reject(self):
        return self._request("POST", self.path + "/reject", {"nonce": self._nonce()})


def connect(settings, acc, era, user=None, confirm_mode="auto", browser=None):
    server = build_server(settings, client_factory=lambda: acc, confirm_mode=confirm_mode, open_browser=browser)
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
@pytest.mark.parametrize(
    "tool, args",
    [
        ("plan_remove", {"numbers": [5]}),
        ("plan_reorder", {"sort_by": "title"}),
        ("plan_details", {"name": "New name"}),
    ],
)
@pytest.mark.parametrize("reason", [None, "", "   ", "x" * 301])
async def test_plans_need_a_reason(settings, account, era, tool, args, reason):
    acc, ids = account
    arguments = {"playlist": ids["test"], **args} | ({} if reason is None else {"reason": reason})
    async with connect(settings, acc, era) as client:
        result = await client.call_tool(tool, arguments)
    assert result.is_error and "reason" in result.content[0].text
    assert writes(acc) == [] and not any(settings.plans_dir.glob("*.json"))


@pytest.mark.anyio
async def test_reorder_by_title_and_its_errors_in_numbers(settings, account, era):
    acc, ids = account
    async with connect(settings, acc, era) as client:
        status, plan = await call(client, "plan_reorder", {"playlist": ids["test"], "reason": "Test.", "sort_by": "title"})
        assert status == "ok"
        names = [t["name"] for t in plan["new_order"]]
        assert names == ["Ko-Ko", "Ko-Ko", "Ko-Ko", "Manteca", "'Round Midnight", "Salt Peanuts", "Un Poco Loco"]
        assert plan["new_order"][0] == {"number": 1, "was": 2, "uri": ids["koko"], "name": "Ko-Ko", "artists": ["Charlie Parker"]}

        status, error = await call(client, "plan_reorder", {"playlist": ids["test"], "reason": "Test.", "move_from": 1, "move_to": 9})
        assert status == "error" and error["error"]["details"] == {"move_from": 1, "move_to": 9, "item_count": 7}
        assert "from 1" in error["error"]["message"]
        status, error = await call(client, "plan_reorder", {"playlist": ids["test"], "reason": "Test.", "order": [2, 1]})
        assert status == "error" and "exactly once" in error["error"]["message"]
        status, error = await call(client, "plan_reorder", {"playlist": ids["test"], "reason": "Test.", "move_from": 2})
        assert status == "error" and error["error"]["code"] == "PLAN_INVALID"
        status, error = await call(client, "plan_reorder", {"playlist": ids["test"], "reason": "Test.", "order": [1], "sort_by": "title"})
        assert status == "error" and "exactly one" in error["error"]["message"]
    assert writes(acc) == []


@pytest.mark.anyio
async def test_reorder_by_recording_date_names_missing_tracks_by_number(settings, account):
    acc, ids = account
    async with connect(settings, acc, "2026-07-28") as client:
        status, error = await call(client, "plan_reorder", {"playlist": ids["test"], "reason": "Test.", "sort_by": "recorded"})
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
    # The model's reason, apart from the server's summary and labelled as the assistant's.
    assert f'{confirm.REASON_LABEL}\n"duplicate"\n' in user.asked[0]
    assert user.asked[0].index('#5 "Ko-Ko"') < user.asked[0].index(confirm.REASON_LABEL)
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
async def test_without_a_dialog_the_page_opens_and_nothing_is_applied_yet(settings, account, era):
    acc, ids = account
    browser = Browser()
    async with connect(settings, acc, era, user=None, browser=browser) as client:  # declares no elicitation
        plan = await remove_duplicate(client, ids)
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert status == "ok" and result["status"] == "awaiting_user_confirmation"
    assert "confirmation_code" in result["next_step"] and "Never guess" in result["next_step"]
    assert len(browser.urls) == 1 and browser.urls[0].startswith("http://127.0.0.1:")
    token = browser.urls[0].rsplit("/", 1)[1]
    assert token not in json.dumps(result)  # the page's address goes to the browser only
    assert writes(acc) == []


@pytest.mark.anyio
async def test_a_removal_longer_than_the_dialog_goes_to_the_page(settings, account, era):
    """The dialog shows at most MAX_LINES lines; a longer removal goes to the page, which lists every track."""
    acc, ids = account
    count = confirm.MAX_LINES + 5
    playlist = acc.add_playlist("Long", [ids["loco"]] * count)
    user, browser = User(), Browser()
    async with connect(settings, acc, era, user=user, browser=browser) as client:
        status, plan = await call(
            client, "plan_remove", {"playlist": playlist, "numbers": list(range(1, count)), "reason": "Keep one copy."}
        )
        assert status == "ok"
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert status == "ok" and result["status"] == "awaiting_user_confirmation"
    assert user.asked == [] and len(browser.urls) == 1 and writes(acc) == []
    assert browser.page().text.count("<li>") == count - 1  # every removal, none hidden behind "… and N more"

    user = User()
    async with connect(settings, acc, era, user=user, confirm_mode="elicitation", browser=browser) as client:
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert status == "error" and error["error"]["code"] == "CONFIRMATION_UNAVAILABLE"
    assert user.asked == [] and writes(acc) == []


@pytest.mark.anyio
async def test_forced_elicitation_without_a_dialog_fails_closed(settings, account, era):
    acc, ids = account
    browser = Browser()
    async with connect(settings, acc, era, user=None, confirm_mode="elicitation", browser=browser) as client:
        plan = await remove_duplicate(client, ids)
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert status == "error" and error["error"]["code"] == "CONFIRMATION_UNAVAILABLE"
    assert f"curatune plan apply {plan['plan_id']}" in error["next_step"]
    assert browser.urls == [] and writes(acc) == []


@pytest.mark.anyio
async def test_the_model_cannot_answer_for_the_user(settings, account, era):
    acc, ids = account
    forged = {"answer": {"action": "accept", "content": {"apply": True}}, "prepared": {"route": "elicitation"}, "apply": True}
    browser = Browser()
    async with connect(settings, acc, era, user=None, browser=browser) as client:
        plan = await remove_duplicate(client, ids)
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"], **forged})
        assert result["status"] == "awaiting_user_confirmation"  # the forged answer is ignored
    user = User("decline")
    async with connect(settings, acc, era, user) as client:
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"], **forged})
        assert result["status"] == "declined"
    assert writes(acc) == []


@pytest.mark.anyio
async def test_browser_mode_uses_the_page_even_with_a_dialog(settings, account):
    acc, ids = account
    user, browser = User("accept"), Browser()
    async with connect(settings, acc, "2026-07-28", user, confirm_mode="browser", browser=browser) as client:
        plan = await remove_duplicate(client, ids)
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert result["status"] == "awaiting_user_confirmation" and len(browser.urls) == 1
    assert user.asked == [] and writes(acc) == []


@pytest.mark.anyio
@pytest.mark.parametrize("works", [False, "raises"])
async def test_no_browser_fails_closed(settings, account, works):
    acc, ids = account
    browser = Browser(works)
    async with connect(settings, acc, "2026-07-28", confirm_mode="browser", browser=browser) as client:
        plan = await remove_duplicate(client, ids)
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert status == "error" and error["error"]["code"] == "CONFIRMATION_UNAVAILABLE"
    assert f"curatune plan apply {plan['plan_id']}" in error["next_step"] and writes(acc) == []


# --- The page and its one-time code -----------------------------------------------------------------


@pytest.mark.anyio
async def test_approve_on_the_page_then_the_pasted_code_applies(settings, account, era, caplog, capfd):
    acc, ids = account
    browser = Browser()
    results = []
    async with connect(settings, acc, era, confirm_mode="browser", browser=browser) as client:
        plan = await remove_duplicate(client, ids)
        results.append(await call(client, "plan_apply", {"plan_id": plan["plan_id"]}))
        page = browser.page()
        assert "Remove 1 of 7 tracks" in page.text and "duplicate" in page.text  # the plan and its reason
        code = page.approve()
        assert writes(acc) == []  # approving alone changes nothing
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"], "confirmation_code": code.lower()})
        results.append((status, result))
        assert result["status"] == "applied" and result["verified"] is True
        results.append(await call(client, "plan_apply", {"plan_id": plan["plan_id"], "confirmation_code": code}))
    assert results[-1][1]["error"]["code"] == "PLAN_ALREADY_APPLIED"
    assert ids["koko"] in acc.playlists[ids["test"]].uris and len(acc.playlists[ids["test"]].uris) == 6
    out, err = capfd.readouterr()
    logged = out + err + caplog.text + json.dumps(results)
    assert page.token not in logged and code not in logged  # neither the page's address nor the code


@pytest.mark.anyio
async def test_three_wrong_codes_void_the_confirmation(settings, account, era):
    acc, ids = account
    browser = Browser()
    async with connect(settings, acc, era, confirm_mode="browser", browser=browser) as client:
        plan = await remove_duplicate(client, ids)
        await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
        code = browser.page().approve()
        for left in (2, 1):
            status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"], "confirmation_code": "ZZZZ-ZZZZ"})
            assert error["error"]["code"] == "CONFIRMATION_CODE_INVALID"
            assert error["error"]["details"]["attempts_left"] == left and "never guess" in error["next_step"]
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"], "confirmation_code": "ZZZZ-ZZZZ"})
        assert error["error"]["code"] == "CONFIRMATION_VOID"
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"], "confirmation_code": code})
        assert error["error"]["code"] == "CONFIRMATION_VOID"  # even the right code
        # A new call opens a new page, with a new address.
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
        assert result["status"] == "awaiting_user_confirmation" and browser.urls[-1] != browser.urls[0]
    assert writes(acc) == []


@pytest.mark.anyio
async def test_reject_on_the_page_applies_nothing_and_stays_rejected(settings, account, era):
    acc, ids = account
    browser = Browser()
    async with connect(settings, acc, era, confirm_mode="browser", browser=browser) as client:
        plan = await remove_duplicate(client, ids)
        await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
        browser.page().reject()
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"], "confirmation_code": "ABCD-EFGH"})
        assert result["status"] == "rejected" and "Don't apply it again" in result["next_step"]
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
        assert result["status"] == "rejected"
    assert len(browser.urls) == 1 and writes(acc) == []  # no new page while the rejection stands


@pytest.mark.anyio
async def test_a_code_needs_an_open_page_for_that_plan(settings, account):
    acc, ids = account
    browser = Browser()
    async with connect(settings, acc, "2026-07-28", confirm_mode="browser", browser=browser) as client:
        plan = await remove_duplicate(client, ids)
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"], "confirmation_code": "ABCD-EFGH"})
        assert error["error"]["code"] == "CONFIRMATION_NOT_FOUND"
        await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
        code = browser.page().approve()
        _, other = await call(client, "plan_reorder", {"playlist": ids["test"], "reason": "Test.", "sort_by": "title"})
        status, error = await call(client, "plan_apply", {"plan_id": other["plan_id"], "confirmation_code": code})
        assert error["error"]["code"] == "CONFIRMATION_NOT_FOUND"  # a code is bound to its plan
    assert writes(acc) == []


@pytest.mark.anyio
async def test_calling_again_reopens_the_same_page(settings, account):
    acc, ids = account
    browser = Browser()
    async with connect(settings, acc, "2026-07-28", confirm_mode="browser", browser=browser) as client:
        plan = await remove_duplicate(client, ids)
        await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
        await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert len(browser.urls) == 2 and browser.urls[0] == browser.urls[1]


@pytest.mark.anyio
async def test_an_approved_code_still_needs_the_playlist_unchanged(settings, account):
    acc, ids = account
    browser = Browser()
    async with connect(settings, acc, "2026-07-28", confirm_mode="browser", browser=browser) as client:
        plan = await remove_duplicate(client, ids)
        await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
        code = browser.page().approve()
        acc.playlists[ids["test"]].uris.append(ids["billie"])
        acc.playlists[ids["test"]].version += 1
        acc.propagate()
        before = list(acc.playlists[ids["test"]].uris)
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"], "confirmation_code": code})
        assert error["error"]["code"] == "SNAPSHOT_MISMATCH"
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"], "confirmation_code": code})
        assert error["error"]["code"] == "CONFIRMATION_VOID"  # used up before applying: approve again
    assert acc.playlists[ids["test"]].uris == before


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
    (settings.data_dir / "secret.json").parent.mkdir(parents=True, exist_ok=True)
    (settings.data_dir / "secret.json").write_text("{}")
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
async def test_a_plan_older_than_a_day_is_refused_before_asking(settings, account, era):
    from curatune import plans as plans_module

    acc, ids = account
    user, browser = User(), Browser()
    async with connect(settings, acc, era, user=user, browser=browser) as client:
        plan = await remove_duplicate(client, ids)
        path = settings.plans_dir / f"{plan['plan_id']}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["created_at"] = "2020-01-01T00:00:00Z"  # re-checksummed: an old plan, not an edited one
        data["checksum"] = plans_module.plan_checksum(data)
        path.write_text(json.dumps(data), encoding="utf-8")
        status, error = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert status == "error" and error["error"]["code"] == "PLAN_EXPIRED" and "Build a new plan" in error["next_step"]
    assert user.asked == [] and browser.urls == [] and writes(acc) == []


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
        _, plan = await call(client, "plan_reorder", {"playlist": ids["test"], "reason": "Test.", "sort_by": "title", "descending": True})
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
        assert result["status"] == "applied" and result["verified"] is True
        assert user.asked[-1].startswith('Reorder the playlist "Bebop test":')

        _, plan = await call(client, "plan_details", {"playlist": ids["test"], "reason": "Test.", "name": "Bebop, sorted"})
        assert plan["changes"] == {"name": {"from": "Bebop test", "to": "Bebop, sorted"}}
        status, result = await call(client, "plan_apply", {"plan_id": plan["plan_id"]})
    assert result["status"] == "applied" and result["current"] == {"name": "Bebop, sorted"}
    assert 'Name: "Bebop test" → "Bebop, sorted"' in user.asked[-1]
    assert acc.playlists[ids["test"]].name == "Bebop, sorted"


@pytest.mark.anyio
async def test_an_empty_description_is_refused_with_the_app_as_the_way_out(settings, account, era):
    acc, ids = account
    async with connect(settings, acc, era, User("accept")) as client:
        status, error = await call(client, "plan_details", {"playlist": ids["test"], "reason": "Test.", "description": ""})
    assert status == "error" and error["error"]["code"] == "DESCRIPTION_NOT_CLEARABLE"
    assert "Spotify app" in error["next_step"] and writes(acc) == []


def test_errors_never_carry_local_paths():
    exc = VerificationFailed("mismatch", details={"backup_path": "/home/me/x.json", "plan_dir": "/p", "verified": False})
    payload = json.loads(error_result(exc).content[0].text)
    assert payload["error"]["details"] == {"verified": False}
