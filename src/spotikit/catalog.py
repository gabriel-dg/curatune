"""Read-only catalog lookups: track search, single track, album track listing."""

from __future__ import annotations

from typing import Any

from .errors import InvalidArgument
from .http import SpotifyClient
from .models import normalize_album, normalize_track
from .refs import parse_id

SEARCH_MAX_LIMIT = 10


def _filter(field: str, value: str) -> str:
    value = value.strip().replace('"', "")
    return f'{field}:"{value}"' if " " in value else f"{field}:{value}"


def build_query(
    text: str | None = None,
    track: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    year: str | None = None,
) -> str:
    parts = [text.strip()] if text and text.strip() else []
    for field, value in (("track", track), ("artist", artist), ("album", album), ("year", year)):
        if value and value.strip():
            parts.append(_filter(field, value))
    return " ".join(parts)


def search_tracks(
    client: SpotifyClient,
    text: str | None = None,
    *,
    track: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    year: str | None = None,
    limit: int = SEARCH_MAX_LIMIT,
    offset: int = 0,
    market: str | None = None,
) -> dict[str, Any]:
    query = build_query(text, track, artist, album, year)
    if not query:
        raise InvalidArgument("Provide a query or at least one filter.")
    if not 1 <= limit <= SEARCH_MAX_LIMIT:
        raise InvalidArgument(f"limit must be between 1 and {SEARCH_MAX_LIMIT}.", details={"limit": limit})
    if offset < 0:
        raise InvalidArgument("offset must be >= 0.", details={"offset": offset})

    page = client.get("/search", q=query, type="track", limit=limit, offset=offset, market=market)["tracks"]
    warnings = []
    if year:
        warnings.append(
            {
                "code": "YEAR_IS_RELEASE_YEAR",
                "message": "The year filter matches the edition's release year, not the recording year.",
            }
        )
    return {
        "query": query,
        "market": market,
        "limit": limit,
        "offset": offset,
        "total": page.get("total"),
        "next_offset": offset + limit if page.get("next") else None,
        "results": [normalize_track(t) for t in page.get("items") or [] if t],
        "warnings": warnings,
    }


def get_track(client: SpotifyClient, ref: str, market: str | None = None) -> dict[str, Any]:
    track_id = parse_id(ref, "track")
    return {"track": normalize_track(client.get(f"/tracks/{track_id}", market=market))}


def get_album_tracks(client: SpotifyClient, ref: str, market: str | None = None) -> dict[str, Any]:
    album_id = parse_id(ref, "album")
    album = client.get(f"/albums/{album_id}", market=market)
    page = album.get("tracks") or {}
    raw_tracks = list(page.get("items") or [])
    while page.get("next"):
        page = client.get(page["next"])
        raw_tracks.extend(page.get("items") or [])

    album_out = normalize_album(album) or {}
    album_out.update(
        {
            "id": album.get("id"),
            "total_tracks": album.get("total_tracks"),
            "url": (album.get("external_urls") or {}).get("spotify"),
        }
    )
    embedded = {k: album_out[k] for k in ("name", "uri", "album_type", "release_date", "release_date_precision", "artists")}
    return {"album": album_out, "tracks": [normalize_track(t, album=embedded) for t in raw_tracks if t]}
