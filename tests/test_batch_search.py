import threading
import time

import pytest

from curatune import catalog
from curatune.errors import InvalidArgument, NotFound


class Tokens:
    def __init__(self):
        self.calls = 0

    def access_token(self, force_refresh=False):
        self.calls += 1
        return "t"

    def user_id(self):
        return "me"


class FakeThreadClient:
    """Stands in for the per-thread SpotifyClient created inside the batch."""

    instances = []
    active = 0
    peak = 0
    lock = threading.Lock()

    def __init__(self, tokens, **kwargs):
        self.tokens = tokens
        FakeThreadClient.instances.append(self)

    def get(self, path, **params):
        with FakeThreadClient.lock:
            FakeThreadClient.active += 1
            FakeThreadClient.peak = max(FakeThreadClient.peak, FakeThreadClient.active)
        time.sleep(0.02)
        with FakeThreadClient.lock:
            FakeThreadClient.active -= 1
        if "missing" in params["q"]:
            raise NotFound("nope")
        item = {"type": "track", "uri": f"spotify:track:{params['q'][:5]}", "name": params["q"], "artists": []}
        return {"tracks": {"items": [item], "total": 1, "next": None}}


@pytest.fixture(autouse=True)
def fake_client(monkeypatch):
    FakeThreadClient.instances, FakeThreadClient.active, FakeThreadClient.peak = [], 0, 0
    monkeypatch.setattr(catalog, "SpotifyClient", FakeThreadClient)


class Parent:
    def __init__(self):
        self.tokens = Tokens()


def test_results_keep_input_order_and_ids():
    queries = [{"id": f"q{i}", "track": f"song {i}"} for i in range(8)]
    result = catalog.search_tracks_batch(Parent(), queries)
    assert [s["id"] for s in result["searches"]] == [f"q{i}" for i in range(8)]
    assert all(s["ok"] for s in result["searches"]) and result["failed"] == 0


def test_runs_concurrently_but_within_worker_limit():
    catalog.search_tracks_batch(Parent(), [{"query": f"x{i}"} for i in range(12)], workers=3)
    assert 1 < FakeThreadClient.peak <= 3
    assert len(FakeThreadClient.instances) <= 3  # one client (HTTP session) per worker thread


def test_one_failure_does_not_fail_the_batch():
    result = catalog.search_tracks_batch(Parent(), [{"query": "ok"}, {"query": "missing"}, {"track": ""}])
    assert [s["ok"] for s in result["searches"]] == [True, False, False]
    assert result["searches"][1]["error"]["code"] == "NOT_FOUND"
    assert result["searches"][2]["error"]["code"] == "INVALID_ARGUMENT"  # empty query
    assert result["failed"] == 2


def test_default_ids_are_indexes_and_market_is_inherited():
    result = catalog.search_tracks_batch(Parent(), [{"query": "a"}, {"query": "b", "market": "US"}], market="AR")
    assert [s["id"] for s in result["searches"]] == ["0", "1"]
    assert [s["market"] for s in result["searches"]] == ["AR", "US"]


def test_token_is_warmed_once_before_threads():
    parent = Parent()
    catalog.search_tracks_batch(parent, [{"query": "a"}])
    assert parent.tokens.calls == 1


@pytest.mark.parametrize(
    "queries",
    [[], {"query": "a"}, [{"query": "a", "artsit": "typo"}], [{"query": "a", "limit": "10"}], [{"query": "a"}] * 51],
)
def test_invalid_batches_are_rejected_up_front(queries):
    with pytest.raises(InvalidArgument):
        catalog.search_tracks_batch(Parent(), queries)


def test_workers_bounds():
    with pytest.raises(InvalidArgument):
        catalog.search_tracks_batch(Parent(), [{"query": "a"}], workers=5)
