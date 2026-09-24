"""spotikit: deterministic Spotify playlist operations (library + thin CLI).

Public library surface, intended to be wrapped later (e.g. by an MCP server):

    from spotikit import load_settings, connect
    client = connect(load_settings())
    playlists.get_playlist(client, "<playlist id, URI, or URL>")

Removals and reorders are only exposed through `plans` (build, show, apply).
"""

from __future__ import annotations

from . import catalog, playlists, plans, recordings
from .auth import TokenManager
from .config import Settings, load_settings
from .errors import SpotikitError
from .http import SpotifyClient
from .writelog import WriteLog

__version__ = "0.1.0"


def connect(settings: Settings | None = None) -> SpotifyClient:
    settings = settings or load_settings()
    return SpotifyClient(TokenManager(settings), write_log=WriteLog(settings.write_log_path))


__all__ = [
    "Settings",
    "SpotifyClient",
    "SpotikitError",
    "TokenManager",
    "catalog",
    "connect",
    "load_settings",
    "playlists",
    "plans",
    "recordings",
]
