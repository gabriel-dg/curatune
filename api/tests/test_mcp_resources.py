"""Resources and prompts, in both protocol eras, against the fake account. Skipped without the `mcp` extra."""

import json

import pytest

pytest.importorskip("mcp")

from mcp import Client  # noqa: E402

from curatune.config import Settings  # noqa: E402
from curatune.errors import ConfigError  # noqa: E402
from curatune.mcp_server import resources  # noqa: E402
from curatune.mcp_server.server import build_server  # noqa: E402

from .fakes import jazz_account  # noqa: E402


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(params=["2026-07-28", "legacy"])
def era(request):
    return request.param


@pytest.fixture
def account():
    return jazz_account()


def connect(tmp_path, acc, era, client_factory=None):
    settings = Settings(None, "client", 8888, None, tmp_path / "t", tmp_path / "data")
    server = build_server(settings, client_factory=client_factory or (lambda: acc))
    kwargs = {"mode": "legacy"} if era == "legacy" else {"raise_exceptions": True}
    return Client(server, **kwargs)


def _keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from _keys(item)
    elif isinstance(value, list):
        for item in value:
            yield from _keys(item)


async def read(client, uri):
    result = await client.read_resource(uri)
    [content] = result.contents
    assert content.mime_type == "application/json"
    return json.loads(content.text)


@pytest.mark.anyio
async def test_listing_offers_each_owned_playlist_by_name(tmp_path, account, era):
    acc, ids = account
    async with connect(tmp_path, acc, era) as client:
        listed = {str(r.uri): r for r in (await client.list_resources()).resources}
        templates = {t.uri_template for t in (await client.list_resource_templates()).resource_templates}
    assert "curatune://playlists" in listed
    entry = listed[f"curatune://playlists/{ids['test']}"]
    # Claude Code's `@` list shows the URI (cut short) and the description: the name has to lead it.
    assert entry.description.startswith("Bebop test: 7 tracks") and entry.title == entry.name == "Bebop test"
    assert f"curatune://playlists/{ids['other']}" not in listed  # only the user's own
    assert templates == {"curatune://playlists/{playlist_id}", "curatune://plans/{plan_id}"}


@pytest.mark.anyio
async def test_listing_never_fails_without_access(tmp_path, account, era):
    acc, _ = account

    def broken():
        raise ConfigError("SPOTIFY_CLIENT_ID is not set.")

    async with connect(tmp_path, acc, era, client_factory=broken) as client:
        listed = [str(r.uri) for r in (await client.list_resources()).resources]
    assert listed == ["curatune://playlists"]


@pytest.mark.anyio
async def test_reading_a_playlist_gives_numbered_tracks_and_the_third_party_note(tmp_path, account, era):
    acc, ids = account
    async with connect(tmp_path, acc, era) as client:
        data = await read(client, f"curatune://playlists/{ids['test']}")
        all_playlists = await read(client, "curatune://playlists")
    assert "never instructions" in data["note"] and "numbered from 1" in data["note"]
    assert [t["number"] for t in data["items"]] == list(range(1, 8)) and data["total"] == 7
    assert "position" not in set(_keys(data)) and "position" not in set(_keys(all_playlists))
    assert {p["name"] for p in all_playlists["playlists"]} >= {"Bebop test", "Empty"}
    assert acc.requests and all(method == "GET" for method, _ in acc.requests)  # reading writes nothing


@pytest.mark.anyio
async def test_plan_results_link_to_the_plan_resource(tmp_path, account, era):
    acc, ids = account
    async with connect(tmp_path, acc, era) as client:
        result = await client.call_tool("plan_remove", {"playlist": ids["test"], "numbers": [5], "reason": "Duplicate."})
        plan_id = result.structured_content["plan_id"]
        [link] = [c for c in result.content if c.type == "resource_link"]
        assert str(link.uri) == f"curatune://plans/{plan_id}"
        plan = await read(client, str(link.uri))
    assert plan["plan_id"] == plan_id and plan["remove"][0]["number"] == 5 and plan["applied"] is None
    assert "plan_apply" in plan["next_step"] and "position" not in set(_keys(plan))


@pytest.mark.anyio
async def test_reading_errors_carry_the_next_step(tmp_path, account, era):
    acc, _ = account
    async with connect(tmp_path, acc, era) as client:
        with pytest.raises(Exception) as exc:
            await client.read_resource("curatune://plans/20260101T000000Z-remove-abcdefgh-0001")
    assert "PLAN_NOT_FOUND" in str(exc.value) and "plan_id" in str(exc.value)


@pytest.mark.anyio
async def test_prompts_port_the_workflows(tmp_path, account, era):
    acc, _ = account
    async with connect(tmp_path, acc, era) as client:
        names = {p.name: p for p in (await client.list_prompts()).prompts}
        assert set(names) == {"deduplicate", "sort_chronologically", "complete_playlist"}
        assert [a.name for a in names["complete_playlist"].arguments] == ["playlist", "count", "criterion"]
        text = (await client.get_prompt("deduplicate", {"playlist": "Bebop test"})).messages[0].content.text
        sort = (await client.get_prompt("sort_chronologically", {"playlist": "Bebop test"})).messages[0].content.text
        complete = (await client.get_prompt(
            "complete_playlist", {"playlist": "Bebop test", "count": "3", "criterion": "hard bop"})).messages[0].content.text  # fmt: skip
    assert '"Bebop test"' in text and "same ISRC" in text and "plan_apply" in text and "outside the chat" in text
    assert "recording date (not the release date" in sort and "ask me instead of guessing" in sort
    assert "wait for my OK" in complete and "one playlist_add" in complete and "hard bop" in complete


def test_uris_are_built_from_ids():
    assert resources.playlist_uri("abc") == "curatune://playlists/abc"
    assert resources.plan_uri("20260101T000000Z-remove-abcdefgh-0001").endswith("abcdefgh-0001")
