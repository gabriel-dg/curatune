"""Thin HTTP client for the Spotify Web API: auth header, retries, error mapping, pagination."""

from __future__ import annotations

import time
from typing import Any, Iterator, Protocol

import requests

from . import metrics
from .errors import ApiError, Forbidden, InvalidArgument, NotFound, RateLimited
from .writelog import WriteLog

API_BASE = "https://api.spotify.com/v1"
MAX_RETRY_AFTER_SECONDS = 60


class TokenProvider(Protocol):
    def access_token(self, force_refresh: bool = False) -> str: ...

    def user_id(self) -> str | None: ...


class SpotifyClient:
    def __init__(
        self,
        tokens: TokenProvider,
        session: requests.Session | None = None,
        max_retries: int = 3,
        timeout: float = 30,
        write_log: WriteLog | None = None,
    ):
        self.tokens = tokens
        self.write_log = write_log
        self.session = session or requests.Session()
        self.max_retries = max_retries
        self.timeout = timeout
        self._user_id: str | None = None

    # --- Core request -------------------------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
    ) -> Any:
        url = path if path.startswith("http") else f"{API_BASE}{path}"
        params = {k: v for k, v in (params or {}).items() if v is not None}
        refreshed = False
        force_refresh = False
        attempt = 0
        while True:
            headers = {"Authorization": f"Bearer {self.tokens.access_token(force_refresh=force_refresh)}"}
            force_refresh = False
            try:
                with metrics.timed("api"):
                    resp = self.session.request(
                        method, url, params=params, json=json, headers=headers, timeout=self.timeout
                    )
            except requests.RequestException as exc:
                if attempt < self.max_retries:
                    attempt += 1
                    time.sleep(2**attempt)
                    continue
                raise ApiError("Network error contacting Spotify.", code="NETWORK_ERROR", details={"error": str(exc)}) from None

            status = resp.status_code
            if 200 <= status < 300:
                if not resp.content:
                    return None
                return resp.json()

            if status == 401 and not refreshed:
                # Access token rejected: force one refresh and retry.
                refreshed = True
                force_refresh = True
                continue

            if status == 429:
                retry_after = int(resp.headers.get("Retry-After", "1") or "1")
                if attempt < self.max_retries and retry_after <= MAX_RETRY_AFTER_SECONDS:
                    attempt += 1
                    time.sleep(retry_after)
                    continue
                raise RateLimited(
                    "Spotify rate limit reached.",
                    details={"retry_after_seconds": retry_after, "method": method, "path": path},
                )

            if status >= 500 and attempt < self.max_retries:
                attempt += 1
                time.sleep(2**attempt)
                continue

            raise _map_error(resp, method, path)

    def get(self, path: str, **params: Any) -> Any:
        return self.request("GET", path, params=params)

    def post(self, path: str, body: Any) -> Any:
        return self.request("POST", path, json=body)

    def put(self, path: str, body: Any) -> Any:
        return self.request("PUT", path, json=body)

    def delete(self, path: str, body: Any) -> Any:
        return self.request("DELETE", path, json=body)

    def paginate(self, path: str, **params: Any) -> Iterator[dict[str, Any]]:
        """Yield every element of a paging object, following `next` links."""
        page = self.get(path, **params)
        while page:
            yield from page.get("items", [])
            next_url = page.get("next")
            page = self.get(next_url) if next_url else None

    # --- Current user -------------------------------------------------------------------------

    def current_user_id(self) -> str:
        if self._user_id is None:
            self._user_id = self.tokens.user_id() or self.get("/me")["id"]
        return self._user_id


def _map_error(resp: requests.Response, method: str, path: str) -> ApiError:
    try:
        body = resp.json()
    except ValueError:
        body = {}
    error = body.get("error") if isinstance(body, dict) else None
    spotify_message = error.get("message") if isinstance(error, dict) else error
    details = {"status": resp.status_code, "method": method, "path": path, "spotify_message": spotify_message}
    message = f"Spotify API error {resp.status_code}" + (f": {spotify_message}" if spotify_message else "")
    if resp.status_code == 400:
        return InvalidArgument(message, details=details, code="API_BAD_REQUEST")
    if resp.status_code == 403:
        return Forbidden(message, details=details)
    if resp.status_code == 404:
        return NotFound(message, details=details)
    return ApiError(message, details=details)
