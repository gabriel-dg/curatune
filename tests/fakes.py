"""In-memory stand-in for SpotifyClient that mimics playlist item semantics."""

from __future__ import annotations

import html
from typing import Any

from curatune.plans import simulate

PLAYLIST_ID = "AbCdEfGhIjKlMnOpQrStUv"  # synthetic


def track_uri(n: int) -> str:
    return f"spotify:track:{n:022d}"


class FakeSpotify:
    """With `lag=True`, reads keep returning the pre-write snapshot_id until `propagate()` is
    called, while items are always current (the behaviour observed live). The playlist list's
    item total lags the same way (observed live by spotikit-web)."""

    def __init__(self, uris: list[str], owner_id: str = "me", lag: bool = False, write_log=None):
        self.uris = list(uris)
        self.owner_id = owner_id
        self.lag = lag
        self.write_log = write_log
        self.name = "Test"
        self.description = ""
        self.ignore_details = False  # Spotify answering 200 without applying (as it does for visibility)
        self.other_playlists: list[dict[str, Any]] = []
        self.version = 1
        self.visible_version = 1
        self.visible_count = len(self.uris)
        self.mutations: list[tuple[str, Any]] = []

    @property
    def snapshot_id(self) -> str:
        return f"snap-{self.version}"

    def propagate(self) -> None:
        self.visible_version = self.version
        self.visible_count = len(self.uris)

    def current_user_id(self) -> str:
        return "me"

    def get(self, path: str, **params: Any) -> Any:
        assert path == f"/playlists/{PLAYLIST_ID}", path
        return {
            "id": PLAYLIST_ID,
            "uri": f"spotify:playlist:{PLAYLIST_ID}",
            "name": self.name,
            "description": html.escape(self.description),  # Spotify returns descriptions HTML-escaped
            "owner": {"id": self.owner_id, "display_name": "Owner"},
            "collaborative": False,
            "public": False,
            "snapshot_id": f"snap-{self.visible_version}",
            "external_urls": {},
        }

    def paginate(self, path: str, **params: Any):
        if path == "/me/playlists":
            yield {**self.get(f"/playlists/{PLAYLIST_ID}"), "items": {"total": self.visible_count}}
            yield from self.other_playlists
            return
        assert path == f"/playlists/{PLAYLIST_ID}/items", path
        for uri in self.uris:
            yield {
                "added_at": "2026-01-01T00:00:00Z",
                "is_local": False,
                "item": {
                    "type": "track",
                    "uri": uri,
                    "id": uri.rsplit(":", 1)[-1],
                    "name": f"Track {int(uri.rsplit(':', 1)[-1])}",
                    "artists": [{"name": "Artist", "uri": "spotify:artist:x"}],
                    "album": {"name": "Album", "uri": "spotify:album:y"},
                    "duration_ms": 180_000,
                },
            }

    def _bump(self) -> dict[str, str]:
        self.version += 1
        if not self.lag:
            self.visible_version = self.version
            self.visible_count = len(self.uris)
        return {"snapshot_id": self.snapshot_id}

    def post(self, path: str, body: Any) -> Any:
        self.mutations.append(("post", body))
        pos = body.get("position", len(self.uris))
        self.uris[pos:pos] = body["uris"]
        return self._bump()

    def delete(self, path: str, body: Any) -> Any:
        self.mutations.append(("delete", body))
        doomed = {i["uri"] for i in body["items"]}
        self.uris = [u for u in self.uris if u not in doomed]
        return self._bump()

    def put(self, path: str, body: Any) -> Any:
        self.mutations.append(("put", body))
        if path == f"/playlists/{PLAYLIST_ID}":  # change details: 200 with an empty body
            if not self.ignore_details:
                self.name = body.get("name", self.name)
                self.description = body.get("description", self.description)
            return None
        op = {"op": "move", **{k: body[k] for k in ("range_start", "insert_before", "range_length")}}
        self.uris = simulate(self.uris, [op])
        return self._bump()
