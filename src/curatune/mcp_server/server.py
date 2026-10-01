"""The MCP server: per-process runtime, result envelopes, and the client capability probe.

Each tool call gets a fresh SpotifyClient (requests.Session is not shared across the worker threads
that run tools); all calls share one TokenManager, whose lock serializes token refreshes. Writes
(create, add, recording dates) take a process-wide lock.
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
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
from . import confirm
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
    # Plans
    "PLAN_INVALID": "Check the numbers and arguments against playlist_show, then build the plan again.",
    "PLAN_NOT_FOUND": "Use a plan_id from a plan_* result; build a new plan if needed.",
    "PLAN_CHECKSUM_MISMATCH": "The plan file was changed after it was built, so it can't be applied. Build a new plan.",
    "PLAN_INCONSISTENT": "The plan file doesn't match what it would do, so it can't be applied. Build a new plan.",
    "PLAN_ALREADY_APPLIED": "This plan was applied before; nothing changed now. Read the playlist to see its state.",
    "NO_CHANGES": "Nothing to do: the playlist already has that order, name, or description.",
    "RECORDING_DATES_MISSING": "Store dates for the listed tracks with recordings_set (with source and confidence; "
    "say when unsure), then build the plan again.",
    "SNAPSHOT_MISMATCH": "Nothing changed: the playlist changed since the plan was built. Build a new plan and show "
    "it to the user again.",
    "APPLY_FAILED": "Applying stopped partway: the playlist may be partly changed (a backup was saved first). Tell "
    "the user, read the playlist, and don't retry blindly.",
    "VERIFICATION_FAILED": "The plan was applied, but the playlist doesn't match the expected result. Tell the user, "
    "read the playlist, and don't retry blindly.",
}


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def ok_result(data: dict[str, Any]) -> CallToolResult:
    """Structured content plus the same JSON as text (for clients that only read text)."""
    return CallToolResult(content=[TextContent(type="text", text=_json(data))], structured_content=data)


def _without_local_paths(value: Any) -> Any:
    """Drop `*_path` and `*_dir` keys (backups, plan files, the token): local paths never reach the model."""
    if isinstance(value, dict):
        return {k: _without_local_paths(v) for k, v in value.items() if not k.endswith(("_path", "_dir"))}
    if isinstance(value, list):
        return [_without_local_paths(v) for v in value]
    return value


def error_result(exc: CuratuneError, next_step: str | None = None) -> CallToolResult:
    payload: dict[str, Any] = {"error": numbered(_without_local_paths(exc.to_dict()))}
    step = next_step or NEXT_STEPS.get(exc.code)
    if step:
        payload["next_step"] = step
    return CallToolResult(content=[TextContent(type="text", text=_json(payload))], is_error=True)


class Runtime:
    """Settings, tokens, and clients, created lazily so that a configuration error is reported by the
    tools instead of keeping the server from starting."""

    def __init__(
        self,
        settings: Settings | None = None,
        client_factory: Callable[[], Any] | None = None,
        tokens: Any = None,
        confirm_mode: str | None = None,
    ):
        self._settings = settings
        self._client_factory = client_factory
        self._tokens = tokens
        self._confirm_mode = confirm_mode
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

    def confirm_mode(self) -> str:
        """`CURATUNE_MCP_CONFIRM` (read after the settings, so `.env` counts), unless set explicitly."""
        if self._confirm_mode is not None:
            return self._confirm_mode
        self.settings()
        return confirm.confirm_mode()

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
        """Record, once per kind of client, what it declares (no personal data): the protocol version, the
        client's name and version, and its capabilities. Logged to stderr and kept in
        `<data dir>/mcp_clients.json`, since some clients (Claude Code) don't keep a server's stderr."""
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
        entry = {"client": key[1], "version": key[2], "protocol": key[0], "capabilities": declared}
        try:
            self._remember_client(entry)
        except Exception:  # noqa: BLE001 - a read-only or broken data dir must not break a tool call
            logger.warning("could not record the client in mcp_clients.json", exc_info=True)

    def _remember_client(self, entry: dict[str, Any]) -> None:
        path = self.settings().data_dir / "mcp_clients.json"
        with self._init_lock:
            try:
                known = json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                known = []
            if any({k: e.get(k) for k in entry} == entry for e in known):
                return
            known.append({**entry, "first_seen": datetime.now(timezone.utc).strftime("%Y-%m-%d")})
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(known, indent=2, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)


def build_server(
    settings: Settings | None = None,
    client_factory: Callable[[], Any] | None = None,
    tokens: Any = None,
    confirm_mode: str | None = None,
) -> MCPServer:
    """The curatune MCP server. Tests pass a fake `client_factory` (and `tokens` for auth_status, and
    `confirm_mode` instead of CURATUNE_MCP_CONFIRM)."""
    from . import tools

    server = MCPServer("curatune", instructions=INSTRUCTIONS, version=__version__)
    tools.register(server, Runtime(settings, client_factory, tokens, confirm_mode))
    return server
