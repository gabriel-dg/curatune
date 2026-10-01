"""Read-only catalog lookups: track search, single track, album track listing."""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .errors import InvalidArgument, CuratuneError
from .http import SpotifyClient
from .models import normalize_album, normalize_track
from .refs import parse_id

SEARCH_MAX_LIMIT = 10
BATCH_MAX_QUERIES = 50
BATCH_MAX_WORKERS = 4  # modest: Development Mode quota is shared per developer account
BATCH_QUERY_KEYS = {"id", "query", "track", "artist", "album", "year", "limit", "offset", "market"}


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


def search_tracks_batch(
    client: SpotifyClient,
    queries: list[dict[str, Any]],
    market: str | None = None,
    workers: int = BATCH_MAX_WORKERS,
) -> dict[str, Any]:
    """Run several track searches concurrently. A failed search does not fail the batch.

    Each query: {"id"?, "query"?, "track"?, "artist"?, "album"?, "year"?, "limit"?, "offset"?, "market"?}.
    Results keep the input order; `id` defaults to the query's index.
    """
    if not isinstance(queries, list) or not queries:
        raise InvalidArgument("Expected a non-empty JSON array of search queries.")
    if len(queries) > BATCH_MAX_QUERIES:
        raise InvalidArgument(f"At most {BATCH_MAX_QUERIES} queries per batch.", details={"count": len(queries)})
    for i, q in enumerate(queries):
        if not isinstance(q, dict):
            raise InvalidArgument("Each query must be a JSON object.", details={"index": i})
        unknown = set(q) - BATCH_QUERY_KEYS
        if unknown:
            raise InvalidArgument("Unknown query keys.", details={"index": i, "unknown": sorted(unknown)})
        for key in ("limit", "offset"):
            if key in q and (not isinstance(q[key], int) or isinstance(q[key], bool)):
                raise InvalidArgument(f"{key} must be an integer.", details={"index": i, key: q[key]})
    if not 1 <= workers <= BATCH_MAX_WORKERS:
        raise InvalidArgument(f"workers must be between 1 and {BATCH_MAX_WORKERS}.", details={"workers": workers})

    # Refresh the token (if needed) once, before threads start asking for it.
    client.tokens.access_token()
    local = threading.local()

    def thread_client() -> SpotifyClient:
        # One HTTP session per worker thread (requests.Session is not meant to be shared).
        if not hasattr(local, "client"):
            local.client = SpotifyClient(client.tokens)
        return local.client

    def run(index: int, q: dict[str, Any]) -> dict[str, Any]:
        search_id = str(q.get("id", index))
        try:
            result = search_tracks(
                thread_client(),
                q.get("query"),
                track=q.get("track"),
                artist=q.get("artist"),
                album=q.get("album"),
                year=q.get("year"),
                limit=q.get("limit", SEARCH_MAX_LIMIT),
                offset=q.get("offset", 0),
                market=q.get("market", market),
            )
            return {"id": search_id, "ok": True, **result}
        except CuratuneError as exc:
            return {"id": search_id, "ok": False, "error": exc.to_dict()}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        searches = list(pool.map(run, range(len(queries)), queries))
    return {"count": len(searches), "failed": sum(not s["ok"] for s in searches), "searches": searches}


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
