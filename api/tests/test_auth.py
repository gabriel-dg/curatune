import json
import socket
import threading
import time
import urllib.error
import urllib.request

import pytest

from curatune import auth, config
from curatune.config import Settings, load_settings
from curatune.errors import AuthError, AuthExpired, ConfigError


def test_pkce_challenge_matches_rfc7636_vector():
    verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    assert auth.code_challenge_for(verifier) == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


def test_code_verifier_length_and_charset():
    verifier = auth.generate_code_verifier()
    assert 43 <= len(verifier) <= 128
    assert all(c.isalnum() or c in "-_.~" for c in verifier)


def test_authorize_url_has_pkce_and_state():
    url = auth.build_authorize_url("cid", "http://127.0.0.1:8888/callback", "chal", "st")
    assert "code_challenge_method=S256" in url and "code_challenge=chal" in url and "state=st" in url
    assert "client_secret" not in url


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _run_callback(port, expected_state):
    box = {}

    def target():
        try:
            box["code"] = auth._wait_for_callback(port, expected_state, timeout=5)
        except Exception as exc:  # noqa: BLE001
            box["error"] = exc

    thread = threading.Thread(target=target)
    thread.start()
    return thread, box


def _hit(url):
    for _ in range(50):
        try:
            urllib.request.urlopen(url, timeout=2).read()
            return
        except (urllib.error.URLError, ConnectionError):  # not listening yet, or a reset on Windows
            time.sleep(0.05)


def _status(url):
    """The HTTP status of a GET, retrying only while the server is not listening yet."""
    for _ in range(50):
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                return resp.status
        except urllib.error.HTTPError as exc:
            return exc.code
        except (urllib.error.URLError, ConnectionError):
            time.sleep(0.05)
    raise AssertionError("the callback server never answered")


@pytest.mark.parametrize("forged", ["forged", "%C3%A9t%C3%A9", ""])
def test_callback_rejects_a_wrong_state_and_keeps_waiting(forged):
    port = _free_port()
    thread, box = _run_callback(port, "expected")
    assert _status(f"http://127.0.0.1:{port}/callback?code=evil&state={forged}") == 400
    assert _status(f"http://127.0.0.1:{port}/callback?code=abc&state=expected") == 200
    thread.join()
    assert box == {"code": "abc"}


def test_callback_reports_a_state_mismatch_when_only_wrong_states_arrived():
    port = _free_port()
    box = {}

    def target():
        try:
            auth._wait_for_callback(port, "expected", timeout=1.5)
        except Exception as exc:  # noqa: BLE001
            box["error"] = exc

    thread = threading.Thread(target=target)
    thread.start()
    assert _status(f"http://127.0.0.1:{port}/callback?code=abc&state=forged") == 400
    thread.join()
    assert isinstance(box.get("error"), AuthError)
    assert box["error"].code == "AUTH_STATE_MISMATCH"


def test_an_idle_connection_does_not_block_the_callback(monkeypatch):
    monkeypatch.setattr(auth, "CALLBACK_SOCKET_TIMEOUT_SECONDS", 0.5)
    port = _free_port()
    thread, box = _run_callback(port, "expected")
    for _ in range(50):  # wait until it listens, then connect and send nothing
        try:
            idle = socket.create_connection(("127.0.0.1", port), timeout=2)
            break
        except ConnectionError:
            time.sleep(0.05)
    try:
        assert _status(f"http://127.0.0.1:{port}/callback?code=abc&state=expected") == 200
        thread.join(timeout=10)
    finally:
        idle.close()
    assert box == {"code": "abc"}


def test_login_binds_the_callback_port_before_opening_the_browser(tmp_path):
    port = _free_port()
    manager = auth.TokenManager(_settings(tmp_path))

    class Opened(Exception):
        pass

    def browser(url):
        socket.create_connection(("127.0.0.1", port), timeout=2).close()  # refused if nothing listens yet
        raise Opened

    with pytest.raises(Opened):
        manager.login(port=port, browser=browser, announce=False, timeout=5)


def test_login_on_a_busy_port_fails_before_showing_or_opening_the_url(tmp_path, capsys):
    opened = []
    with socket.socket() as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        port = busy.getsockname()[1]
        with pytest.raises(AuthError, match="Cannot listen"):
            auth.TokenManager(_settings(tmp_path)).login(port=port, browser=opened.append, timeout=5)
    assert opened == []
    assert "accounts.spotify.com" not in capsys.readouterr().err


def test_callback_returns_code_on_valid_state():
    port = _free_port()
    thread, box = _run_callback(port, "expected")
    _hit(f"http://127.0.0.1:{port}/callback?code=abc&state=expected")
    thread.join()
    assert box == {"code": "abc"}


class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class _Session:
    def __init__(self, resp):
        self.resp = resp
        self.posted = []

    def post(self, url, data=None, headers=None, timeout=None):
        self.posted.append(data)
        return self.resp


def _settings(tmp_path) -> Settings:
    return Settings(
        project_root=tmp_path / "repo",
        client_id="cid",
        redirect_port=8888,
        market=None,
        token_dir=tmp_path / "tokens",
        data_dir=tmp_path / "data",
    )


def _stored_token(expires_at=0.0):
    return {
        "client_id": "cid",
        "access_token": "old-access",
        "refresh_token": "old-refresh",
        "expires_at": expires_at,
        "scope": "playlist-read-private",
        "authorized_at": "2026-03-01T00:00:00Z",
        "user_id": "me",
    }


def test_expired_refresh_token_discards_token_and_raises(tmp_path):
    settings = _settings(tmp_path)
    session = _Session(_Resp(400, {"error": "invalid_grant", "error_description": "Refresh token revoked"}))
    manager = auth.TokenManager(settings, session=session)
    manager.store.save(_stored_token())
    with pytest.raises(AuthExpired) as exc:
        manager.access_token()
    assert exc.value.details["refresh_expires_approx"] == "2026-09-01T00:00:00Z"
    assert not settings.token_path.exists()
    assert "client_secret" not in session.posted[0]


class _OtherProcessRotates(_Session):
    """Another process refreshes first with the same refresh token: it stores the rotated token, and
    Spotify then answers this process's refresh with invalid_grant."""

    def __init__(self, store, rotated, then=None):
        super().__init__(_Resp(400, {"error": "invalid_grant", "error_description": "Invalid refresh token"}))
        self.store, self.rotated, self.then = store, rotated, then

    def post(self, url, data=None, headers=None, timeout=None):
        self.posted.append(data)
        if len(self.posted) == 1:
            self.store.save(self.rotated)
            return self.resp
        return self.then


def test_refresh_uses_a_token_rotated_by_another_process(tmp_path):
    settings = _settings(tmp_path)
    manager = auth.TokenManager(settings)
    manager.store.save(_stored_token())
    rotated = dict(_stored_token(expires_at=time.time() + 3600), access_token="other-access", refresh_token="other-refresh")
    manager.session = _OtherProcessRotates(manager.store, rotated)
    assert manager.access_token() == "other-access"
    assert json.loads(settings.token_path.read_text())["refresh_token"] == "other-refresh"


def test_refresh_renews_an_expired_token_rotated_by_another_process(tmp_path):
    settings = _settings(tmp_path)
    manager = auth.TokenManager(settings)
    manager.store.save(_stored_token())
    rotated = dict(_stored_token(), access_token="other-access", refresh_token="other-refresh")
    renewed = _Resp(200, {"access_token": "renewed-access", "expires_in": 3600})
    manager.session = _OtherProcessRotates(manager.store, rotated, then=renewed)
    assert manager.access_token() == "renewed-access"
    assert manager.session.posted[1]["refresh_token"] == "other-refresh"
    assert json.loads(settings.token_path.read_text())["refresh_token"] == "other-refresh"


def test_refresh_keeps_old_refresh_token_and_authorized_at(tmp_path):
    settings = _settings(tmp_path)
    session = _Session(_Resp(200, {"access_token": "new-access", "expires_in": 3600}))
    manager = auth.TokenManager(settings, session=session)
    manager.store.save(_stored_token())
    assert manager.access_token() == "new-access"
    stored = json.loads(settings.token_path.read_text())
    assert stored["refresh_token"] == "old-refresh"
    assert stored["authorized_at"] == "2026-03-01T00:00:00Z"


def test_refresh_rotates_refresh_token_when_returned(tmp_path):
    settings = _settings(tmp_path)
    session = _Session(_Resp(200, {"access_token": "a", "refresh_token": "rotated", "expires_in": 3600}))
    manager = auth.TokenManager(settings, session=session)
    manager.store.save(_stored_token())
    manager.access_token()
    assert json.loads(settings.token_path.read_text())["refresh_token"] == "rotated"


def test_status_never_exposes_tokens(tmp_path):
    manager = auth.TokenManager(_settings(tmp_path))
    manager.store.save(_stored_token(expires_at=time.time() + 3600))
    dumped = json.dumps(manager.status())
    assert "old-access" not in dumped and "old-refresh" not in dumped


def test_token_file_is_created_owner_only(tmp_path, monkeypatch):
    created = []
    real_open = auth.os.open

    def spy_open(path, flags, mode=0o777):
        created.append((str(path), flags, mode))
        return real_open(path, flags, mode)

    monkeypatch.setattr(auth.os, "open", spy_open)
    store = auth.TokenStore(tmp_path / "tokens" / "token.json")
    (tmp_path / "tokens").mkdir()
    (tmp_path / "tokens" / "token.tmp").write_text("stale")  # leftover from an interrupted save
    store.save({"access_token": "a"})
    assert len(created) == 1
    path, flags, mode = created[0]
    assert path.endswith("token.tmp") and mode == 0o600 and flags & auth.os.O_EXCL
    assert json.loads(store.path.read_text()) == {"access_token": "a"}
    assert not (tmp_path / "tokens" / "token.tmp").exists()


def test_add_months_clamps_day():
    from datetime import datetime, timezone

    assert auth.add_months(datetime(2026, 8, 31, tzinfo=timezone.utc), 6).day == 28


def test_token_dir_inside_repo_is_rejected(monkeypatch, tmp_path):
    monkeypatch.setenv("CURATUNE_PROJECT_DIR", str(tmp_path))
    monkeypatch.setenv("CURATUNE_TOKEN_DIR", str(tmp_path / "tokens"))
    with pytest.raises(ConfigError):
        load_settings()


def test_data_dir_elsewhere_in_a_monorepo_is_rejected(monkeypatch, tmp_path):
    # The package is one folder (api/) of a larger repository: the guard covers the whole repository.
    (tmp_path / "repo" / ".git").mkdir(parents=True)
    monkeypatch.setenv("CURATUNE_PROJECT_DIR", str(tmp_path / "repo" / "api"))
    monkeypatch.setenv("CURATUNE_TOKEN_DIR", str(tmp_path / "tokens"))
    monkeypatch.setenv("CURATUNE_DATA_DIR", str(tmp_path / "repo" / "web" / "data"))
    with pytest.raises(ConfigError) as exc:
        load_settings()
    assert exc.value.details["repository_root"] == str(tmp_path / "repo")


def test_a_git_folder_further_up_is_not_the_projects(monkeypatch, tmp_path):
    # A version-controlled ancestor two levels up (a home directory, say) must not swallow the defaults.
    (tmp_path / ".git").mkdir()
    monkeypatch.setenv("CURATUNE_PROJECT_DIR", str(tmp_path / "work" / "curatune"))
    monkeypatch.setenv("CURATUNE_TOKEN_DIR", str(tmp_path / "tokens"))
    monkeypatch.setenv("CURATUNE_DATA_DIR", str(tmp_path / "data"))
    assert load_settings().data_dir == (tmp_path / "data").resolve()


def test_redirect_port_is_configurable(monkeypatch, tmp_path):
    monkeypatch.setenv("CURATUNE_PROJECT_DIR", str(tmp_path / "repo"))
    monkeypatch.setenv("CURATUNE_TOKEN_DIR", str(tmp_path / "tokens"))
    monkeypatch.setenv("SPOTIFY_REDIRECT_PORT", "9090")
    assert load_settings().redirect_uri == "http://127.0.0.1:9090/callback"


def test_settings_read_the_product_variables(monkeypatch, tmp_path):
    monkeypatch.setenv("CURATUNE_PROJECT_DIR", str(tmp_path / "repo"))
    monkeypatch.setenv("CURATUNE_TOKEN_DIR", str(tmp_path / "tokens"))
    monkeypatch.setenv("CURATUNE_MARKET", "ar")
    settings = load_settings()
    assert settings.project_root == (tmp_path / "repo").resolve()
    assert settings.token_dir == (tmp_path / "tokens").resolve()
    assert settings.market == "AR"


@pytest.mark.parametrize(("platform", "base_var"), [("win32", "LOCALAPPDATA"), ("linux", "XDG_CONFIG_HOME")])
def test_default_token_dir_is_named_after_the_product(monkeypatch, tmp_path, platform, base_var):
    monkeypatch.setenv("CURATUNE_PROJECT_DIR", str(tmp_path / "repo"))
    monkeypatch.delenv("CURATUNE_TOKEN_DIR", raising=False)
    monkeypatch.setattr(config.sys, "platform", platform)
    monkeypatch.setenv(base_var, str(tmp_path / "base"))
    assert load_settings().token_dir == tmp_path / "base" / "curatune"
