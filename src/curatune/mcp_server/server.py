"""The MCP server: per-process runtime, result envelopes, and the client capability probe.

Each tool call gets a fresh SpotifyClient (requests.Session is not shared across the worker threads
that run tools); all calls share one TokenManager, whose lock serializes token refreshes. Writes
(create, add, recording dates) take a process-wide lock.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Any, Callable

from mcp.server import MCPServer
from mcp.server.mcpserver import Context
from mcp.types import CallToolResult, TextContent

from .. import __version__
from ..auth import TokenManager
from ..config import Settings, load_settings
from ..errors import CuratuneError
from ..http import SpotifyClient
from ..writelog import WriteLog
from .instructions import INSTRUCTIONS
from .numbering import numbered

logger = logging.getLogger("curatune.mcp")

_LOGIN = "Ask the user to run `curatune auth login` in a terminal (it opens the browser to authorize curatune)."

# What the model should do next, by error code. Codes without an entry need no special handling.
NEXT_STEPS = {
    "CONFIG_ERROR": "curatune is not set up: the user sets SPOTIFY_CLIENT_ID in curatune's .env (see the README). "
    "Never ask for credentials in the chat.",
    "AUTH_REQUIRED": _LOGIN,
    "AUTH_EXPIRED": "The Spotify authorization expired (it lasts 6 months). " + _LOGIN,
    "AUTH_ERROR": _LOGIN,
    "FORBIDDEN": "Only playlists the user owns or collaborates on can be read track by track or changed.",
    "NOT_FOUND": "Check the ID: take playlist IDs from playlists_list and track or album IDs from tool results "
    "or the user's message.",
    "INVALID_REFERENCE": "Pass an ID, a spotify: URI, or an open.spotify.com URL taken from a tool result or the "
    "user's message.",
    "DUPLICATE_NAME": "Ask the user whether to use the existing playlist or create another with the same name "
    "(allow_duplicate_name).",
    "RATE_LIMITED": "Wait retry_after_seconds before retrying, and avoid bursts of calls.",
    "CONCURRENT_MODIFICATION": "The playlist changed while it was being read; try again.",
    "NETWORK_ERROR": "Spotify could not be reached; try again later.",
    "API_ERROR": "Spotify returned an error; try again later, and tell the user if it persists.",
}


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def ok_result(data: dict[str, Any]) -> CallToolResult:
    """Structured content plus the same JSON as text (for clients that only read text)."""
    return CallToolResult(content=[TextContent(type="text", text=_json(data))], structured_content=data)


def error_result(exc: CuratuneError) -> CallToolResult:
    payload: dict[str, Any] = {"error": numbered(exc.to_dict())}
    if exc.code in NEXT_STEPS:
        payload["next_step"] = NEXT_STEPS[exc.code]
    return CallToolResult(content=[TextContent(type="text", text=_json(payload))], is_error=True)


class Runtime:
    """Settings, tokens, and clients, created lazily so that a configuration error is reported by the
    tools instead of keeping the server from starting."""

    def __init__(
        self,
        settings: Settings | None = None,
        client_factory: Callable[[], Any] | None = None,
        tokens: Any = None,
    ):
        self._settings = settings
        self._client_factory = client_factory
        self._tokens = tokens
        self._init_lock = threading.Lock()
        self.write_lock = threading.Lock()
        self._seen_clients: set[tuple[Any, ...]] = set()

    def settings(self) -> Settings:
        with self._init_lock:
            if self._settings is None:
                self._settings = load_settings()
            return self._settings

    def tokens(self) -> Any:
        settings = self.settings()
        with self._init_lock:
            if self._tokens is None:
                self._tokens = TokenManager(settings)
            return self._tokens

    def client(self) -> Any:
        if self._client_factory is not None:
            return self._client_factory()
        return SpotifyClient(self.tokens(), write_log=WriteLog(self.settings().write_log_path))

    def call(self, ctx: Context, fn: Callable[[Any], dict[str, Any]], *, write: bool = False) -> CallToolResult:
        """Run `fn(client)` and wrap its view; curatune errors become tool errors the model can read."""
        self.probe(ctx)
        try:
            if write:
                with self.write_lock:
                    data = fn(self.client())
            else:
                data = fn(self.client())
        except CuratuneError as exc:
            return error_result(exc)
        return ok_result(data)

    def probe(self, ctx: Context) -> None:
        """Log, once per kind of client, what it declares (no personal data): the protocol version, the
        client's name and version, and its capabilities. Records what each real client supports."""
        try:
            params = ctx.session.client_params
            info = params.client_info if params is not None else None
            caps = ctx.client_capabilities
            declared = caps.model_dump(mode="json", by_alias=True, exclude_none=True) if caps is not None else None
            key = (ctx.protocol_version, info and info.name, info and info.version, _json(declared))
        except Exception:  # noqa: BLE001 - the probe must never break a tool call
            return
        with self._init_lock:
            if key in self._seen_clients:
                return
            self._seen_clients.add(key)
        logger.info("client: name=%s version=%s protocol=%s capabilities=%s", key[1], key[2], key[0], key[3])


def build_server(
    settings: Settings | None = None,
    client_factory: Callable[[], Any] | None = None,
    tokens: Any = None,
) -> MCPServer:
    """The curatune MCP server. Tests pass a fake `client_factory` (and `tokens` for auth_status)."""
    from . import tools

    server = MCPServer("curatune", instructions=INSTRUCTIONS, version=__version__)
    tools.register(server, Runtime(settings, client_factory, tokens))
    return server
