"""Normalization of Spotify API objects into the stable JSON shapes documented in README.md."""

from __future__ import annotations

from typing import Any

TRACK_KEYS = (
    "uri", "id", "type", "name", "artists", "album", "duration_ms", "duration",
    "disc_number", "track_number", "isrc", "explicit", "is_local", "is_playable", "url",
)  # fmt: skip


def format_duration(ms: int | None) -> str | None:
    if ms is None:
        return None
    minutes, seconds = divmod(ms // 1000, 60)
    return f"{minutes}:{seconds:02d}"


def normalize_artist(artist: dict[str, Any]) -> dict[str, Any]:
    return {"name": artist.get("name"), "uri": artist.get("uri")}


def normalize_album(album: dict[str, Any] | None) -> dict[str, Any] | None:
    if not album:
        return None
    return {
        "name": album.get("name"),
        "uri": album.get("uri"),
        "album_type": album.get("album_type"),
        "release_date": album.get("release_date"),
        "release_date_precision": album.get("release_date_precision"),
        "artists": [normalize_artist(a) for a in album.get("artists") or []],
    }


def normalize_track(obj: dict[str, Any] | None, album: dict[str, Any] | None = None) -> dict[str, Any]:
    """Normalize a full or simplified track (or episode) object.

    `album` is used for simplified tracks (e.g. from album listings), which lack the album field.
    A missing object (unavailable playlist item) yields all keys set to None.
    """
    if not obj:
        return {key: None for key in TRACK_KEYS} | {"artists": [], "is_local": False}

    if obj.get("type") == "episode":
        show = obj.get("show") or {}
        album_out: dict[str, Any] | None = {
            "name": show.get("name"),
            "uri": show.get("uri"),
            "album_type": "show",
            "release_date": obj.get("release_date"),
            "release_date_precision": obj.get("release_date_precision"),
            "artists": [],
        }
    else:
        album_out = normalize_album(obj.get("album")) or album

    duration_ms = obj.get("duration_ms")
    return {
        "uri": obj.get("uri"),
        "id": obj.get("id"),
        "type": obj.get("type", "track"),
        "name": obj.get("name"),
        "artists": [normalize_artist(a) for a in obj.get("artists") or []],
        "album": album_out,
        "duration_ms": duration_ms,
        "duration": format_duration(duration_ms),
        "disc_number": obj.get("disc_number"),
        "track_number": obj.get("track_number"),
        "isrc": (obj.get("external_ids") or {}).get("isrc"),
        "explicit": obj.get("explicit"),
        "is_local": bool(obj.get("is_local")),
        "is_playable": obj.get("is_playable"),
        "url": (obj.get("external_urls") or {}).get("spotify"),
    }


def normalize_playlist_item(entry: dict[str, Any], position: int) -> dict[str, Any]:
    # "item" is the post-2026 field name; "track" is the deprecated alias.
    obj = entry.get("item") or entry.get("track")
    track = normalize_track(obj)
    track["is_local"] = bool(entry.get("is_local")) or track["is_local"]
    return {"position": position, **track, "added_at": entry.get("added_at")}


def normalize_playlist(playlist: dict[str, Any], current_user_id: str | None) -> dict[str, Any]:
    owner = playlist.get("owner") or {}
    items_ref = playlist.get("items") or playlist.get("tracks") or {}
    return {
        "id": playlist.get("id"),
        "uri": playlist.get("uri"),
        "name": playlist.get("name"),
        "description": playlist.get("description"),
        "owner_id": owner.get("id"),
        "owner_name": owner.get("display_name"),
        "owned": current_user_id is not None and owner.get("id") == current_user_id,
        "collaborative": playlist.get("collaborative"),
        "public": playlist.get("public"),
        "item_count": items_ref.get("total"),
        "snapshot_id": playlist.get("snapshot_id"),
        "url": (playlist.get("external_urls") or {}).get("spotify"),
    }


def brief_track(track: dict[str, Any]) -> dict[str, Any]:
    """Flat, compact view of a normalized track or playlist item (CLI `--brief`).

    Keys are always present: position (playlist items only), uri, name, artists (names), album (name),
    released (edition release date), duration, isrc, playable.
    """
    album = track.get("album") or {}
    brief: dict[str, Any] = {"position": track["position"]} if "position" in track else {}
    brief.update(
        {
            "uri": track.get("uri"),
            "name": track.get("name"),
            "artists": [a.get("name") for a in track.get("artists") or []],
            "album": album.get("name"),
            "released": album.get("release_date"),
            "duration": track.get("duration"),
            "isrc": track.get("isrc"),
            "playable": track.get("is_playable"),
        }
    )
    return brief


def compact_item(item: dict[str, Any]) -> dict[str, Any]:
    """Short form used inside plans: enough to identify an item at a glance."""
    album = item.get("album") or {}
    return {
        "position": item["position"],
        "uri": item.get("uri"),
        "name": item.get("name"),
        "artists": [a["name"] for a in item.get("artists") or []],
        "album": album.get("name"),
        "duration": item.get("duration"),
    }
