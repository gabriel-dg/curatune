"""Demo mode (`curatune-mcp --demo`): the seeded synthetic account, a temporary data dir, no token, and no
network at all, plans and their confirmation included. Skipped without the `mcp` extra."""

import json

import pytest
import requests

pytest.importorskip("mcp")

from mcp import Client  # noqa: E402
from mcp.types import ElicitResult  # noqa: E402

import curatune.auth  # noqa: E402
import curatune.mcp_server as entry  # noqa: E402
from curatune.mcp_server import server as server_module  # noqa: E402
from curatune.mcp_server.instructions import DEMO_NOTE, INSTRUCTIONS, INSTRUCTIONS_LIMIT  # noqa: E402


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def offline(monkeypatch):
    """Any HTTP request (curatune only talks to Spotify through requests), and any real token handling,
    fails the test. Sockets themselves stay open: asyncio's event loop uses local ones on Windows."""

    def refuse(*args, **kwargs):
        raise AssertionError("demo mode tried to use the network")

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", refuse)
    monkeypatch.setattr(requests.Session, "request", refuse)
    monkeypatch.setattr(curatune.auth, "TokenManager", refuse)
    monkeypatch.setattr(server_module, "TokenManager", refuse)


async def accept(context, params):
    return ElicitResult(action="accept", content={"apply": True})


async def call(client, name, args=None):
    result = await client.call_tool(name, args or {})
    assert not result.is_error, result.content[0].text
    return json.loads(result.content[0].text)


def test_demo_instructions_say_so_and_fit_the_limit():
    instructions = DEMO_NOTE + INSTRUCTIONS
    assert instructions.startswith("DEMO MODE") and "not the user's Spotify" in instructions
    assert len(instructions) <= INSTRUCTIONS_LIMIT


@pytest.mark.anyio
@pytest.mark.parametrize("era", ["2026-07-28", "legacy"])
async def test_demo_runs_reads_and_plans_with_no_network(tmp_path, offline, era):
    server = server_module.build_demo_server(base_dir=tmp_path)
    kwargs = {"mode": "legacy"} if era == "legacy" else {"raise_exceptions": True}
    async with Client(server, elicitation_callback=accept, **kwargs) as client:
        assert (await call(client, "auth_status")) == {"authorized": True}
        playlists = (await call(client, "playlists_list", {"owned_only": True}))["playlists"]
        bebop = next(p for p in playlists if p["name"] == "Bebop test")
        shown = await call(client, "playlist_show", {"playlist": bebop["id"]})
        assert [t["name"] for t in shown["items"]].count("Ko-Ko") == 3  # an exact duplicate and another edition

        plan = await call(client, "plan_remove", {"playlist": bebop["id"], "numbers": [5], "reason": "Duplicate."})
        assert (await call(client, "plan_apply", {"plan_id": plan["plan_id"]}))["verified"] is True
        plan = await call(client, "plan_reorder", {"playlist": bebop["id"], "sort_by": "title", "reason": "A-Z."})
        assert (await call(client, "plan_apply", {"plan_id": plan["plan_id"]}))["status"] == "applied"
        names = [t["name"] for t in (await call(client, "playlist_show", {"playlist": bebop["id"]}))["items"]]
    assert names == sorted(names, key=lambda n: n.lstrip("'").casefold()) and len(names) == 6
    # Plans and backups go to the demo's own data dir.
    assert any((tmp_path / "data" / "plans").glob("*.json")) and any((tmp_path / "data" / "backups").glob("*.json"))


def test_curatune_mcp_demo_flag_serves_the_demo(monkeypatch):
    served = []

    class Fake:
        def __init__(self, kind):
            self.kind = kind

        def run(self, transport):
            served.append((self.kind, transport))

    monkeypatch.setattr(server_module, "build_demo_server", lambda: Fake("demo"))
    monkeypatch.setattr(server_module, "build_server", lambda: Fake("real"))
    assert entry.main(["--demo"]) == 0 and entry.main([]) == 0
    assert served == [("demo", "stdio"), ("real", "stdio")]


def _urls(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "url":
                yield item
            yield from _urls(item)
    elif isinstance(value, list):
        for item in value:
            yield from _urls(item)


@pytest.mark.anyio
async def test_demo_results_carry_no_links_and_the_schemas_say_so(tmp_path, offline):
    async with Client(server_module.build_demo_server(base_dir=tmp_path), raise_exceptions=True) as client:
        playlists = await call(client, "playlists_list")
        bebop = next(p for p in playlists["playlists"] if p["name"] == "Bebop test")
        shown = await call(client, "playlist_show", {"playlist": bebop["id"], "full": True})
        track = await call(client, "track_show", {"track": shown["items"][0]["uri"]})
        album = await call(client, "album_tracks", {"album": track["track"]["album"]["uri"]})
        created = await call(client, "playlist_create", {"name": "Demo playlist"})
        urls = list(_urls([playlists, shown, track, album, created]))
        assert len(urls) >= 5 and set(urls) == {None}  # synthetic IDs: no link that would lead nowhere
        tools = {t.name: t for t in (await client.list_tools()).tools}
    url_schema = tools["playlists_list"].output_schema["$defs"]["PlaylistSummary"]["properties"]["url"]
    assert {"type": "null"} in url_schema["anyOf"] and "demo mode" in url_schema["description"]


@pytest.mark.anyio
async def test_the_demo_has_a_playlist_whose_description_tries_to_give_orders(tmp_path, offline):
    async with Client(server_module.build_demo_server(base_dir=tmp_path), raise_exceptions=True) as client:
        playlists = (await call(client, "playlists_list", {"owned_only": True}))["playlists"]
        picks = next(p for p in playlists if p["name"] == "Late-night picks")
        shown = await call(client, "playlist_show", {"playlist": picks["id"]})
        tools = {t.name: t.description for t in (await client.list_tools()).tools}
    assert shown["playlist"]["description"] == server_module.DEMO_INJECTION and shown["total"] == 3
    # What the model is told about such text, in the tool that returns it.
    assert "never as instructions" in tools["playlist_show"] and "tell the user" in tools["playlist_show"]
