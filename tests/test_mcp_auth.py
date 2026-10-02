"""`auth_login`: idempotent, returns at once, finishes in the background, and never shows the token (or the
consent URL) to the model or a log. Skipped without the `mcp` extra."""

import json
import threading

import pytest

pytest.importorskip("mcp")

from mcp import Client  # noqa: E402

from curatune.config import Settings  # noqa: E402
from curatune.errors import AuthError, AuthExpired  # noqa: E402
from curatune.mcp_server.server import build_server  # noqa: E402

from .fakes import jazz_account  # noqa: E402

SECRET = "secret-access-token-0123456789"
CONSENT = "https://accounts.spotify.com/authorize?client_id=client&state=s3cr3t-state"


@pytest.fixture
def anyio_backend():
    return "asyncio"


class Tokens:
    """A TokenManager stand-in: `login` plays the user approving in the browser."""

    def __init__(self, logged_in=False, expired=False, fail=None):
        self.logged_in, self.expired, self.fail = logged_in, expired, fail
        self.logins = []

    def status(self):
        if not self.logged_in:
            return {"logged_in": False}
        return {"logged_in": True, "client_id_matches": True, "missing_scopes": [], "refresh_likely_expired": self.expired}

    def access_token(self, force_refresh=False):
        if not self.logged_in:
            raise AuthExpired("Log in again.")
        if self.expired:
            raise AuthExpired("The Spotify authorization expired.")
        return SECRET

    def login(self, **kwargs):
        self.logins.append(kwargs)
        kwargs["browser"](CONSENT)
        if self.fail:
            raise self.fail
        self.logged_in, self.expired = True, False
        return {"logged_in": True, "access_token": SECRET}


class Browser:
    def __init__(self):
        self.urls = []

    def __call__(self, url):
        self.urls.append(url)
        return True


def server_with(tmp_path, tokens, browser, client_id="client"):
    acc, _ = jazz_account()
    settings = Settings(None, client_id, 8888, None, tmp_path / "t", tmp_path / "data")
    return build_server(settings, client_factory=lambda: acc, tokens=tokens, open_browser=browser)


async def call(client, name):
    result = await client.call_tool(name, {})
    return result.is_error, json.loads(result.content[0].text)


def finish(server):
    if server.runtime.login_thread is not None:
        server.runtime.login_thread.join(timeout=5)


@pytest.mark.anyio
async def test_already_authorized_opens_nothing(tmp_path):
    tokens, browser = Tokens(logged_in=True), Browser()
    server = server_with(tmp_path, tokens, browser)
    async with Client(server, raise_exceptions=True) as client:
        assert await call(client, "auth_login") == (False, {"authorized": True})
    assert tokens.logins == [] and browser.urls == []


@pytest.mark.anyio
@pytest.mark.parametrize("era", ["2026-07-28", "legacy"])
async def test_login_opens_the_consent_page_and_finishes_in_the_background(tmp_path, caplog, capfd, era):
    tokens, browser = Tokens(), Browser()
    server = server_with(tmp_path, tokens, browser)
    kwargs = {"mode": "legacy"} if era == "legacy" else {"raise_exceptions": True}
    async with Client(server, **kwargs) as client:
        error, first = await call(client, "auth_login")
        assert not error and first["authorized"] is False and "auth_status" in first["next_step"]
        finish(server)
        assert (await call(client, "auth_status"))[1] == {"authorized": True}
        again = await call(client, "auth_login")
    assert again == (False, {"authorized": True}) and len(tokens.logins) == 1  # idempotent
    assert tokens.logins[0]["announce"] is False and browser.urls == [CONSENT]
    out, err = capfd.readouterr()
    seen = json.dumps([first, again]) + out + err + caplog.text
    assert SECRET not in seen and "s3cr3t-state" not in seen  # neither the token nor the consent URL


@pytest.mark.anyio
async def test_an_expired_token_logs_in_again(tmp_path):
    tokens, browser = Tokens(logged_in=True, expired=True), Browser()
    server = server_with(tmp_path, tokens, browser)
    async with Client(server, raise_exceptions=True) as client:
        assert (await call(client, "auth_login"))[1]["authorized"] is False
        finish(server)
    assert len(tokens.logins) == 1 and tokens.expired is False


@pytest.mark.anyio
async def test_a_pending_login_is_not_started_twice(tmp_path):
    tokens, browser = Tokens(), Browser()
    server = server_with(tmp_path, tokens, browser)

    release = threading.Event()
    original = tokens.login

    def slow_login(**kwargs):
        release.wait(5)
        return original(**kwargs)

    tokens.login = slow_login
    async with Client(server, raise_exceptions=True) as client:
        await call(client, "auth_login")
        error, second = await call(client, "auth_login")
        release.set()
        finish(server)
    assert not error and "already open" in second["next_step"] and len(tokens.logins) == 1


@pytest.mark.anyio
async def test_a_failed_attempt_is_reported_on_the_next_call(tmp_path):
    tokens, browser = Tokens(fail=AuthError("The authorization timed out.")), Browser()
    server = server_with(tmp_path, tokens, browser)
    async with Client(server, raise_exceptions=True) as client:
        await call(client, "auth_login")
        finish(server)
        tokens.fail = None
        error, retry = await call(client, "auth_login")
        finish(server)
    assert not error and "didn't finish (AUTH_ERROR)" in retry["next_step"] and len(tokens.logins) == 2


@pytest.mark.anyio
async def test_without_a_client_id_it_says_how_to_set_up(tmp_path):
    tokens, browser = Tokens(), Browser()
    server = server_with(tmp_path, tokens, browser, client_id=None)
    async with Client(server, raise_exceptions=True) as client:
        error, data = await call(client, "auth_login")
    assert error and data["error"]["code"] == "CONFIG_ERROR" and "credentials" in data["next_step"]
    assert tokens.logins == [] and browser.urls == []


@pytest.mark.anyio
async def test_a_token_dir_private_to_a_store_app_is_refused(tmp_path, monkeypatch):
    from curatune import datadir

    real, local = datadir._resolve, str(tmp_path / "local")
    monkeypatch.setattr(datadir, "_resolve", lambda p: real(p).replace(local, str(tmp_path / "Packages" / "App" / "LocalCache"), 1))
    tokens, browser = Tokens(), Browser()
    acc, _ = jazz_account()
    settings = Settings(None, "client", 8888, None, tmp_path / "local" / "curatune", tmp_path / "data")
    server = build_server(settings, client_factory=lambda: acc, tokens=tokens, open_browser=browser)
    async with Client(server, raise_exceptions=True) as client:
        error, data = await call(client, "auth_login")
    assert error and data["error"]["code"] == "TOKEN_DIR_VIRTUALIZED" and "terminal" in data["next_step"]
    assert tokens.logins == [] and browser.urls == [] and not (tmp_path / "local").exists()
