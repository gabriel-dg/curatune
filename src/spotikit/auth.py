"""OAuth 2.0 Authorization Code flow with PKCE (no client secret) and token storage.

The token file lives outside the repository (see `Settings.token_dir`). Tokens are never
printed or logged. Spotify refresh tokens expire 6 months after the original authorization,
regardless of refreshes; on `invalid_grant` the stored token is discarded and `AuthExpired`
is raised so the caller can ask for a new login.
"""

from __future__ import annotations

import base64
import calendar
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import requests

from . import metrics
from .config import REDIRECT_HOST, REDIRECT_PATH, SCOPES, Settings, redirect_uri_for
from .errors import AuthError, AuthExpired, AuthRequired

AUTHORIZE_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
ME_URL = "https://api.spotify.com/v1/me"
REFRESH_TOKEN_LIFETIME_MONTHS = 6
ACCESS_TOKEN_SKEW_SECONDS = 60
DEFAULT_LOGIN_TIMEOUT_SECONDS = 300


# --- PKCE helpers -----------------------------------------------------------------------------


def generate_code_verifier() -> str:
    # token_urlsafe(64) yields 86 chars from [A-Za-z0-9_-], within the 43-128 range allowed.
    return secrets.token_urlsafe(64)


def code_challenge_for(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def build_authorize_url(client_id: str, redirect_uri: str, challenge: str, state: str) -> str:
    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
        "state": state,
        "scope": " ".join(SCOPES),
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


# --- Time helpers -----------------------------------------------------------------------------


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def add_months(dt: datetime, months: int) -> datetime:
    month_index = dt.month - 1 + months
    year = dt.year + month_index // 12
    month = month_index % 12 + 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


# --- Local callback server --------------------------------------------------------------------


def _wait_for_callback(port: int, expected_state: str, timeout: float) -> str:
    """Serve one OAuth callback on 127.0.0.1:<port> and return the authorization code."""
    result: dict[str, str | None] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
            parsed = urlparse(self.path)
            if parsed.path != REDIRECT_PATH:
                self.send_response(404)
                self.end_headers()
                return
            params = parse_qs(parsed.query)
            result["state"] = params.get("state", [None])[0]
            result["code"] = params.get("code", [None])[0]
            result["error"] = params.get("error", [None])[0]
            state_ok = hmac.compare_digest(result["state"] or "", expected_state)
            ok = state_ok and result["code"] and not result["error"]
            message = (
                "spotikit: authorization received. You can close this tab."
                if ok
                else "spotikit: authorization failed. Check the terminal output."
            )
            body = f"<html><body><p>{message}</p></body></html>".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            # Silence request logging: the query string contains the authorization code.
            return

    try:
        server = HTTPServer((REDIRECT_HOST, port), Handler)
    except OSError as exc:
        raise AuthError(
            f"Cannot listen on {REDIRECT_HOST}:{port}.",
            details={"port": port, "os_error": str(exc), "hint": "Set SPOTIFY_REDIRECT_PORT or pass --port."},
        ) from None

    server.timeout = 1.0
    deadline = time.monotonic() + timeout
    with server:
        while not result and time.monotonic() < deadline:
            server.handle_request()

    if not result:
        raise AuthError("Timed out waiting for the authorization callback.", details={"timeout_seconds": timeout})
    # State is validated first, before trusting any other callback parameter.
    if not hmac.compare_digest(result.get("state") or "", expected_state):
        raise AuthError("OAuth state mismatch; the callback was rejected.", code="AUTH_STATE_MISMATCH")
    if result.get("error"):
        raise AuthError("Authorization was denied.", details={"spotify_error": result["error"]})
    code = result.get("code")
    if not code:
        raise AuthError("The callback did not include an authorization code.")
    return code


# --- Token storage ----------------------------------------------------------------------------


class TokenStore:
    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict[str, Any] | None:
        if not self.path.exists():
            return None
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise AuthRequired(
                "The stored token file is unreadable. Run `spotikit auth login`.",
                details={"token_path": str(self.path)},
            ) from None

    def save(self, token: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(token, indent=2), encoding="utf-8")
        if os.name == "posix":
            os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    def delete(self) -> bool:
        try:
            self.path.unlink()
            return True
        except FileNotFoundError:
            return False


class _InvalidGrant(Exception):
    pass


# --- Token manager ----------------------------------------------------------------------------


class TokenManager:
    def __init__(self, settings: Settings, session: requests.Session | None = None):
        self.settings = settings
        self.session = session or requests.Session()
        self.store = TokenStore(settings.token_path)

    # Public API

    def login(
        self,
        port: int | None = None,
        open_browser: bool = True,
        timeout: float = DEFAULT_LOGIN_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        client_id = self.settings.require_client_id()
        redirect_uri = redirect_uri_for(port or self.settings.redirect_port)
        verifier = generate_code_verifier()
        state = secrets.token_urlsafe(32)
        url = build_authorize_url(client_id, redirect_uri, code_challenge_for(verifier), state)

        # stderr only: stdout is reserved for the JSON result.
        print(f"Open this URL to authorize spotikit:\n{url}", file=sys.stderr, flush=True)
        if open_browser:
            webbrowser.open(url)

        code = _wait_for_callback(port or self.settings.redirect_port, state, timeout)
        payload = self._token_request(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": client_id,
                "code_verifier": verifier,
            }
        )
        if not payload.get("refresh_token"):
            raise AuthError("The token response did not include a refresh token.")

        now = _utc_now()
        token: dict[str, Any] = {
            "client_id": client_id,
            "access_token": payload["access_token"],
            "refresh_token": payload["refresh_token"],
            "expires_at": time.time() + int(payload.get("expires_in", 3600)),
            "scope": payload.get("scope", ""),
            "authorized_at": _iso(now),
        }
        me = self._fetch_me(token["access_token"])
        token["user_id"] = me.get("id")
        token["display_name"] = me.get("display_name")
        self.store.save(token)
        return self.status()

    def logout(self) -> dict[str, Any]:
        return {"logged_out": self.store.delete(), "token_path": str(self.store.path)}

    def status(self) -> dict[str, Any]:
        token = self.store.load()
        if not token:
            return {"logged_in": False, "token_path": str(self.store.path)}
        granted = token.get("scope", "").split()
        authorized_at = _parse_iso(token["authorized_at"])
        refresh_expires = add_months(authorized_at, REFRESH_TOKEN_LIFETIME_MONTHS)
        return {
            "logged_in": True,
            "user_id": token.get("user_id"),
            "display_name": token.get("display_name"),
            "client_id_matches": token.get("client_id") == self.settings.client_id,
            "scopes": granted,
            "missing_scopes": [s for s in SCOPES if s not in granted],
            "authorized_at": token["authorized_at"],
            "refresh_expires_approx": _iso(refresh_expires),
            "refresh_likely_expired": _utc_now() >= refresh_expires,
            "access_token_expires_at": _iso(datetime.fromtimestamp(int(token["expires_at"]), timezone.utc)),
            "token_path": str(self.store.path),
        }

    def user_id(self) -> str | None:
        token = self.store.load()
        return token.get("user_id") if token else None

    def access_token(self, force_refresh: bool = False) -> str:
        token = self._load_required()
        if force_refresh or token["expires_at"] - ACCESS_TOKEN_SKEW_SECONDS <= time.time():
            token = self._refresh(token)
        return token["access_token"]

    # Internals

    def _load_required(self) -> dict[str, Any]:
        token = self.store.load()
        if not token:
            raise AuthRequired("Not logged in. Run `spotikit auth login`.")
        if self.settings.client_id and token.get("client_id") != self.settings.client_id:
            raise AuthRequired(
                "The stored token belongs to a different client ID. Run `spotikit auth login`.",
                details={"token_path": str(self.store.path)},
            )
        return token

    def _refresh(self, token: dict[str, Any]) -> dict[str, Any]:
        try:
            payload = self._token_request(
                {
                    "grant_type": "refresh_token",
                    "refresh_token": token["refresh_token"],
                    "client_id": token["client_id"],
                }
            )
        except _InvalidGrant as exc:
            self.store.delete()
            authorized_at = token.get("authorized_at")
            raise AuthExpired(
                "The refresh token is expired or revoked (Spotify refresh tokens last 6 months from the "
                "original authorization). The stored token was discarded; run `spotikit auth login`.",
                details={
                    "authorized_at": authorized_at,
                    "refresh_expires_approx": (
                        _iso(add_months(_parse_iso(authorized_at), REFRESH_TOKEN_LIFETIME_MONTHS))
                        if authorized_at
                        else None
                    ),
                    "spotify_error_description": str(exc) or None,
                },
            ) from None

        token["access_token"] = payload["access_token"]
        token["expires_at"] = time.time() + int(payload.get("expires_in", 3600))
        if payload.get("scope"):
            token["scope"] = payload["scope"]
        # The response may or may not rotate the refresh token; keep the old one if absent.
        # `authorized_at` is intentionally preserved: refreshing does not extend the 6-month limit.
        if payload.get("refresh_token"):
            token["refresh_token"] = payload["refresh_token"]
        token["last_refreshed_at"] = _iso(_utc_now())
        self.store.save(token)
        return token

    def _token_request(self, data: dict[str, str]) -> dict[str, Any]:
        try:
            with metrics.timed("auth"):
                resp = self.session.post(
                    TOKEN_URL,
                    data=data,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    timeout=30,
                )
        except requests.RequestException as exc:
            raise AuthError("Network error contacting the Spotify token endpoint.", details={"error": str(exc)}) from None
        if resp.status_code == 200:
            return resp.json()
        try:
            body = resp.json()
        except ValueError:
            body = {}
        error = body.get("error")
        description = body.get("error_description")
        if error == "invalid_grant":
            raise _InvalidGrant(description or "")
        raise AuthError(
            "The Spotify token endpoint returned an error.",
            details={"status": resp.status_code, "error": error, "error_description": description},
        )

    def _fetch_me(self, access_token: str) -> dict[str, Any]:
        try:
            with metrics.timed("auth"):
                resp = self.session.get(ME_URL, headers={"Authorization": f"Bearer {access_token}"}, timeout=30)
        except requests.RequestException as exc:
            raise AuthError("Network error fetching the current user.", details={"error": str(exc)}) from None
        if resp.status_code != 200:
            raise AuthError("Could not fetch the current user after login.", details={"status": resp.status_code})
        return resp.json()
