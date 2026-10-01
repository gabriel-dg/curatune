"""SpotifyClient: retries (429, 5xx, network), 401 refresh, error mapping, pagination, metrics."""

import json

import pytest
import requests

from curatune import http, metrics
from curatune.errors import ApiError, Forbidden, InvalidArgument, NotFound, RateLimited


class Resp:
    def __init__(self, status=200, body=None, headers=None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.content = b"" if body is None else json.dumps(body).encode()

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


class Session:
    """Returns scripted responses (or raises scripted exceptions) in order."""

    def __init__(self, *script):
        self.script = list(script)
        self.calls = []

    def request(self, method, url, params=None, json=None, headers=None, timeout=None):
        self.calls.append({"method": method, "url": url, "params": params, "json": json, "auth": headers["Authorization"]})
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class Tokens:
    def __init__(self):
        self.forced = 0

    def access_token(self, force_refresh=False):
        if force_refresh:
            self.forced += 1
        return f"token-{self.forced}"

    def user_id(self):
        return "me"


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    slept = []
    monkeypatch.setattr(http.time, "sleep", lambda s: slept.append(s))
    metrics.reset()
    return slept


def client(*script):
    session = Session(*script)
    return http.SpotifyClient(Tokens(), session=session), session


def test_success_returns_json_and_drops_none_params():
    c, s = client(Resp(200, {"ok": 1}))
    assert c.get("/x", market=None, limit=5) == {"ok": 1}
    assert s.calls[0]["params"] == {"limit": 5}
    assert s.calls[0]["url"] == "https://api.spotify.com/v1/x"


def test_empty_body_returns_none():
    c, _ = client(Resp(200, None))
    assert c.put("/x", {"a": 1}) is None


def test_429_waits_retry_after_then_succeeds(no_sleep):
    c, s = client(Resp(429, headers={"Retry-After": "3"}), Resp(200, {"ok": 1}))
    assert c.get("/x") == {"ok": 1}
    assert no_sleep == [3] and len(s.calls) == 2


def test_429_gives_up_after_max_retries():
    c, _ = client(*[Resp(429, headers={"Retry-After": "1"})] * 4)
    with pytest.raises(RateLimited) as exc:
        c.get("/x")
    assert exc.value.details["retry_after_seconds"] == 1


def test_429_with_long_retry_after_fails_fast(no_sleep):
    c, s = client(Resp(429, headers={"Retry-After": "3600"}))
    with pytest.raises(RateLimited):
        c.get("/x")
    assert no_sleep == [] and len(s.calls) == 1


def test_5xx_retries_with_backoff_then_succeeds(no_sleep):
    c, _ = client(Resp(503), Resp(502), Resp(200, {"ok": 1}))
    assert c.get("/x") == {"ok": 1}
    assert no_sleep == [2, 4]


def test_5xx_exhausted_maps_to_api_error():
    c, _ = client(*[Resp(500, {"error": {"status": 500, "message": "boom"}})] * 4)
    with pytest.raises(ApiError) as exc:
        c.get("/x")
    assert exc.value.code == "API_ERROR" and exc.value.details["spotify_message"] == "boom"


def test_network_errors_retry_then_raise_network_error():
    c, s = client(*[requests.ConnectionError("down")] * 4)
    with pytest.raises(ApiError) as exc:
        c.get("/x")
    assert exc.value.code == "NETWORK_ERROR" and len(s.calls) == 4


def test_401_forces_one_token_refresh_and_retries():
    c, s = client(Resp(401), Resp(200, {"ok": 1}))
    assert c.get("/x") == {"ok": 1}
    assert c.tokens.forced == 1
    assert [call["auth"] for call in s.calls] == ["Bearer token-0", "Bearer token-1"]


def test_second_401_is_not_retried_again():
    c, s = client(Resp(401), Resp(401, {"error": {"status": 401, "message": "bad token"}}))
    with pytest.raises(ApiError) as exc:
        c.get("/x")
    assert exc.value.details["status"] == 401 and c.tokens.forced == 1 and len(s.calls) == 2


@pytest.mark.parametrize(
    "status, error_type, code",
    [(400, InvalidArgument, "API_BAD_REQUEST"), (403, Forbidden, "FORBIDDEN"), (404, NotFound, "NOT_FOUND")],
)
def test_error_mapping(status, error_type, code):
    c, _ = client(Resp(status, {"error": {"status": status, "message": "nope"}}))
    with pytest.raises(error_type) as exc:
        c.delete("/x", {"items": []})
    assert exc.value.code == code
    assert exc.value.details == {"status": status, "method": "DELETE", "path": "/x", "spotify_message": "nope"}


def test_error_with_non_json_body():
    c, _ = client(Resp(404, None))
    with pytest.raises(NotFound) as exc:
        c.get("/x")
    assert exc.value.details["spotify_message"] is None


def test_paginate_follows_next_links():
    page1 = {"items": [1, 2], "next": "https://api.spotify.com/v1/x?offset=2"}
    page2 = {"items": [3], "next": None}
    c, s = client(Resp(200, page1), Resp(200, page2))
    assert list(c.paginate("/x", limit=2)) == [1, 2, 3]
    assert s.calls[1]["url"] == page1["next"]


@pytest.mark.parametrize(
    "next_url",
    [
        "https://evil.example/v1/x?offset=2",
        "http://api.spotify.com/v1/x?offset=2",  # plain HTTP would expose the token
        "https://api.spotify.com.evil.example/v1/x",
    ],
)
def test_token_is_never_sent_outside_the_web_api(next_url):
    c, s = client(Resp(200, {"items": [1], "next": next_url}))
    with pytest.raises(ApiError) as exc:
        list(c.paginate("/x"))
    assert exc.value.code == "UNTRUSTED_URL"
    assert len(s.calls) == 1  # the untrusted URL was never requested


def test_metrics_count_every_http_attempt():
    c, _ = client(Resp(429, headers={"Retry-After": "0"}), Resp(200, {"ok": 1}))
    c.get("/x")
    assert metrics.snapshot()["api"]["calls"] == 2
