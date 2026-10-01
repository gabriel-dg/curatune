"""In-memory stand-ins for SpotifyClient.

`FakeSpotify` is one playlist with exact item semantics (plans, read lag). `FakeAccount` is a whole
account: several playlists, a small catalog (search, track, album), create and add. Neither calls the
network.
"""

from __future__ import annotations

import html
import re
from typing import Any

from curatune.errors import Forbidden, InvalidArgument, NotFound
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


# --- A whole account ----------------------------------------------------------------------------


def synthetic_id(prefix: str, n: int) -> str:
    """A 22-character Spotify-style ID (letters and digits), clearly synthetic."""
    return f"{prefix}{n:0{22 - len(prefix)}d}"


class _FakeTokens:
    def access_token(self, force_refresh: bool = False) -> str:
        return "fake-token"

    def user_id(self) -> str | None:
        return None


class _FakePlaylist:
    def __init__(self, playlist_id, name, owner_id, uris, description, collaborative, public):
        self.id = playlist_id
        self.name = name
        self.owner_id = owner_id
        self.uris = list(uris)
        self.description = description
        self.collaborative = collaborative
        self.public = public
        self.version = 1
        self.visible_version = 1
        self.visible_count = len(self.uris)


_FILTER_RE = re.compile(r'(\w+):(?:"([^"]*)"|(\S+))')


def _not_found() -> NotFound:
    return NotFound("Spotify API error 404: Resource not found", details={"status": 404})


class FakeAccount:
    """An account with playlists and a catalog. Mimics the API behaviour curatune depends on:

    - with `lag=True`, reads return the pre-write snapshot_id and the playlist list the pre-write
      item count until `propagate()` (observed live);
    - creating a playlist ignores `public: false` while echoing it back (observed live);
    - descriptions come back HTML-escaped;
    - DELETE removes every occurrence of a URI;
    - items of playlists the user neither owns nor collaborates on are forbidden;
    - adding a URI that is not in the catalog fails with 400 (assumed, not verified live).
    """

    def __init__(self, user_id: str = "me", lag: bool = False, write_log=None):
        self.user_id = user_id
        self.lag = lag
        self.write_log = write_log
        self.tokens = _FakeTokens()
        self.tracks: dict[str, dict[str, Any]] = {}
        self.albums: dict[str, dict[str, Any]] = {}
        self.playlists: dict[str, _FakePlaylist] = {}
        self.requests: list[tuple[str, str]] = []
        self._next = 0

    # --- Building the account ---------------------------------------------------------------

    def _new_id(self, prefix: str) -> str:
        self._next += 1
        return synthetic_id(prefix, self._next)

    def add_album(self, name, artists, release_date, tracks, album_type="album") -> list[str]:
        """`tracks`: (name, duration_ms, isrc or None) tuples. Returns the track URIs in album order."""
        album_id = self._new_id("al")
        artist_objs = [{"name": a, "uri": f"spotify:artist:{synthetic_id('ar', sum(map(ord, a)))}"} for a in artists]
        self.albums[album_id] = {
            "id": album_id,
            "uri": f"spotify:album:{album_id}",
            "name": name,
            "album_type": album_type,
            "release_date": release_date,
            "release_date_precision": "day" if len(release_date) == 10 else "year",
            "artists": artist_objs,
            "external_urls": {"spotify": f"https://open.spotify.com/album/{album_id}"},
            "track_ids": [],
        }
        uris = []
        for number, (track_name, duration_ms, isrc) in enumerate(tracks, start=1):
            track_id = self._new_id("tr")
            self.tracks[track_id] = {
                "type": "track",
                "id": track_id,
                "uri": f"spotify:track:{track_id}",
                "name": track_name,
                "artists": artist_objs,
                "album_id": album_id,
                "duration_ms": duration_ms,
                "disc_number": 1,
                "track_number": number,
                "external_ids": {"isrc": isrc} if isrc else {},
                "explicit": False,
                "is_local": False,
                "external_urls": {"spotify": f"https://open.spotify.com/track/{track_id}"},
            }
            self.albums[album_id]["track_ids"].append(track_id)
            uris.append(f"spotify:track:{track_id}")
        return uris

    def add_playlist(self, name, uris, owner_id=None, description="", collaborative=False, public=True) -> str:
        playlist_id = self._new_id("pl")
        owner = owner_id or self.user_id
        self.playlists[playlist_id] = _FakePlaylist(playlist_id, name, owner, uris, description, collaborative, public)
        return playlist_id

    def propagate(self) -> None:
        for p in self.playlists.values():
            p.visible_version, p.visible_count = p.version, len(p.uris)

    # --- Object shapes, as the API returns them ---------------------------------------------

    def _album_obj(self, album_id: str) -> dict[str, Any]:
        return {k: v for k, v in self.albums[album_id].items() if k != "track_ids"}

    def _track_obj(self, track_id: str, market: str | None = None, simplified: bool = False) -> dict[str, Any]:
        raw = self.tracks[track_id]
        obj = {k: v for k, v in raw.items() if k != "album_id"}
        if simplified:
            del obj["external_ids"]  # album listings return simplified tracks, without ISRC
        else:
            obj["album"] = self._album_obj(raw["album_id"])
        if market:
            obj["is_playable"] = True
        return obj

    def _playlist_meta(self, p: _FakePlaylist) -> dict[str, Any]:
        owned = p.owner_id == self.user_id
        return {
            "id": p.id,
            "uri": f"spotify:playlist:{p.id}",
            "name": p.name,
            "description": html.escape(p.description),
            "owner": {"id": p.owner_id, "display_name": "Owner" if owned else "Someone else"},
            "collaborative": p.collaborative,
            "public": p.public,
            "snapshot_id": f"snap-{p.visible_version}",
            "items": {"total": p.visible_count},
            "external_urls": {"spotify": f"https://open.spotify.com/playlist/{p.id}"},
        }

    # --- SpotifyClient interface ------------------------------------------------------------

    def current_user_id(self) -> str:
        return self.user_id

    def thread_client(self) -> FakeAccount:
        return self

    def _playlist(self, playlist_id: str) -> _FakePlaylist:
        if playlist_id not in self.playlists:
            raise _not_found()
        return self.playlists[playlist_id]

    def _editable(self, p: _FakePlaylist) -> None:
        if p.owner_id != self.user_id and not p.collaborative:
            raise Forbidden("Spotify API error 403: Forbidden", details={"status": 403})

    def get(self, path: str, **params: Any) -> Any:
        self.requests.append(("GET", path))
        parts = path.strip("/").split("/")
        market = params.get("market")
        if parts[0] == "playlists" and len(parts) == 2:
            return self._playlist_meta(self._playlist(parts[1]))
        if parts[0] == "tracks" and len(parts) == 2:
            if parts[1] not in self.tracks:
                raise _not_found()
            return self._track_obj(parts[1], market)
        if parts[0] == "albums" and len(parts) == 2:
            if parts[1] not in self.albums:
                raise _not_found()
            items = [self._track_obj(t, market, simplified=True) for t in self.albums[parts[1]]["track_ids"]]
            return {**self._album_obj(parts[1]), "total_tracks": len(items), "tracks": {"items": items, "next": None}}
        if parts == ["search"]:
            return self._search(params)
        raise AssertionError(f"unexpected GET {path}")

    def _search(self, params: dict[str, Any]) -> dict[str, Any]:
        q = params["q"]
        filters = {m[1]: (m[2] if m[2] is not None else m[3]).casefold() for m in _FILTER_RE.finditer(q)}
        words = _FILTER_RE.sub(" ", q).casefold().split()

        def matches(track_id: str) -> bool:
            t = self.tracks[track_id]
            album = self.albums[t["album_id"]]
            artists = " ".join(a["name"] for a in t["artists"]).casefold()
            year = album["release_date"][:4]
            low, _, high = filters.get("year", "").partition("-")
            return (
                filters.get("track", "") in t["name"].casefold()
                and filters.get("artist", "") in artists
                and filters.get("album", "") in album["name"].casefold()
                and (not low or low <= year <= (high or low))
                and all(w in f"{t['name']} {artists} {album['name']}".casefold() for w in words)
            )

        found = [t for t in self.tracks if matches(t)]
        offset, limit = params.get("offset", 0), params.get("limit", 10)
        items = [self._track_obj(t, params.get("market")) for t in found[offset : offset + limit]]
        next_url = "https://api.spotify.com/v1/search?page=next" if offset + limit < len(found) else None
        return {"tracks": {"items": items, "total": len(found), "next": next_url}}

    def paginate(self, path: str, **params: Any):
        self.requests.append(("GET", path))
        if path == "/me/playlists":
            for p in list(self.playlists.values()):
                yield self._playlist_meta(p)
            return
        parts = path.strip("/").split("/")
        assert parts[0] == "playlists" and parts[2] == "items", path
        p = self._playlist(parts[1])
        self._editable(p)
        for uri in list(p.uris):
            item = self._track_obj(uri.rsplit(":", 1)[-1], params.get("market"))
            yield {"added_at": "2026-01-01T00:00:00Z", "is_local": False, "item": item}

    def _bump(self, p: _FakePlaylist) -> dict[str, str]:
        p.version += 1
        if not self.lag:
            p.visible_version, p.visible_count = p.version, len(p.uris)
        return {"snapshot_id": f"snap-{p.version}"}

    def post(self, path: str, body: Any) -> Any:
        self.requests.append(("POST", path))
        if path == "/me/playlists":
            # Spotify makes the playlist public whatever is requested, and echoes the request back.
            playlist_id = self.add_playlist(body["name"], [], description=body.get("description", ""), public=True)
            return {**self._playlist_meta(self.playlists[playlist_id]), "public": body.get("public")}
        parts = path.strip("/").split("/")
        assert parts[0] == "playlists" and parts[2] == "items", path
        p = self._playlist(parts[1])
        self._editable(p)
        if any(u.rsplit(":", 1)[-1] not in self.tracks for u in body["uris"]):
            raise InvalidArgument("Spotify API error 400: Invalid base62 id", code="API_BAD_REQUEST")
        pos = body.get("position", len(p.uris))
        p.uris[pos:pos] = body["uris"]
        return self._bump(p)

    def put(self, path: str, body: Any) -> Any:
        self.requests.append(("PUT", path))
        parts = path.strip("/").split("/")
        p = self._playlist(parts[1])
        self._editable(p)
        if len(parts) == 2:  # details: name and description apply; visibility is ignored, as live
            p.name = body.get("name", p.name)
            p.description = body.get("description", p.description)
            return None
        op = {"op": "move", **{k: body[k] for k in ("range_start", "insert_before", "range_length")}}
        p.uris = simulate(p.uris, [op])
        return self._bump(p)

    def delete(self, path: str, body: Any) -> Any:
        self.requests.append(("DELETE", path))
        p = self._playlist(path.strip("/").split("/")[1])
        self._editable(p)
        doomed = {i["uri"] for i in body["items"]}
        p.uris = [u for u in p.uris if u not in doomed]
        return self._bump(p)


def jazz_account(lag: bool = False, write_log=None) -> tuple[FakeAccount, dict[str, str]]:
    """A seeded account. Track and album names are public facts; every ID and ISRC is synthetic.

    Returns the account and handy IDs: "test" is the user's shuffled playlist with an exact duplicate
    (Ko-Ko twice) and the same recording on another edition (same ISRC); "empty" is the user's;
    "other" belongs to someone else.
    """
    acc = FakeAccount(lag=lag, write_log=write_log)
    koko, billie, now = acc.add_album(
        "The Savoy Recordings",
        ["Charlie Parker"],
        "1945-11-26",
        [("Ko-Ko", 174000, "XXA000000001"), ("Billie's Bounce", 191000, "XXA000000002"),
         ("Now's the Time", 196000, "XXA000000003")],
    )  # fmt: skip
    [koko_reissue] = acc.add_album(
        "Best of Bird", ["Charlie Parker"], "1999", [("Ko-Ko", 174000, "XXA000000001")], album_type="compilation"
    )
    peanuts, manteca = acc.add_album(
        "Groovin' High",
        ["Dizzy Gillespie"],
        "1992",
        [("Salt Peanuts", 199000, "XXA000000004"), ("Manteca", 186000, "XXA000000005")],
        album_type="compilation",
    )
    [midnight] = acc.add_album(
        "Genius of Modern Music", ["Thelonious Monk"], "1951", [("'Round Midnight", 191000, "XXA000000006")]
    )
    [loco] = acc.add_album("The Amazing Bud Powell", ["Bud Powell"], "1951", [("Un Poco Loco", 287000, "XXA000000007")])
    test = acc.add_playlist(
        "Bebop test",
        [loco, koko, midnight, manteca, koko, peanuts, koko_reissue],
        description="A shuffled test playlist & its duplicates",
    )
    empty = acc.add_playlist("Empty", [])
    other = acc.add_playlist("Someone else's", [billie, now], owner_id="someone")
    ids = {"test": test, "empty": empty, "other": other, "koko": koko, "koko_reissue": koko_reissue,
           "billie": billie, "now": now, "loco": loco, "peanuts": peanuts}  # fmt: skip
    return acc, ids
