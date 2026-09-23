"""Playlist operations that are allowed without a plan: list, read, create, add.

There is deliberately no function to change a playlist's name, description, or visibility.
"""

from __future__ import annotations

from typing import Any

from . import _writes
from .errors import ApiError, DuplicateName, Forbidden, InvalidArgument
from .http import SpotifyClient
from .models import normalize_playlist, normalize_playlist_item
from .refs import normalize_item_uri, parse_id

MAX_URIS_PER_REQUEST = 100
ITEMS_PAGE_LIMIT = 50
PLAYLIST_META_FIELDS = "id,uri,name,description,owner(id,display_name),collaborative,public,snapshot_id,external_urls"
READ_ATTEMPTS = 3


def chunks(values: list[Any], size: int) -> list[list[Any]]:
    return [values[i : i + size] for i in range(0, len(values), size)]


def list_playlists(client: SpotifyClient, owned_only: bool = False) -> dict[str, Any]:
    me = client.current_user_id()
    playlists = [normalize_playlist(p, me) for p in client.paginate("/me/playlists", limit=50) if p]
    if owned_only:
        playlists = [p for p in playlists if p["owned"]]
    return {"user_id": me, "count": len(playlists), "playlists": playlists}


def get_playlist(client: SpotifyClient, ref: str, market: str | None = None) -> dict[str, Any]:
    """Read playlist metadata and all items as one consistent snapshot.

    Metadata and items come from separate requests, so the snapshot_id is re-read at the end
    and the whole read is retried if the playlist changed in between.

    Plans must call this with market=None: with a market, Spotify may relink tracks and return
    URIs that differ from the ones actually stored in the playlist.
    """
    playlist_id = parse_id(ref, "playlist")
    me = client.current_user_id()
    for _ in range(READ_ATTEMPTS):
        meta = client.get(f"/playlists/{playlist_id}", fields=PLAYLIST_META_FIELDS, market=market)
        try:
            entries = list(
                client.paginate(
                    f"/playlists/{playlist_id}/items",
                    limit=ITEMS_PAGE_LIMIT,
                    market=market,
                    additional_types="track,episode",
                )
            )
        except Forbidden as exc:
            raise Forbidden(
                "Playlist items are only available for playlists you own or collaborate on.",
                details={**exc.details, "playlist_id": playlist_id},
            ) from None
        check = client.get(f"/playlists/{playlist_id}", fields="snapshot_id")
        if check.get("snapshot_id") == meta.get("snapshot_id"):
            break
    else:
        raise ApiError(
            "The playlist kept changing while it was being read.",
            code="CONCURRENT_MODIFICATION",
            details={"playlist_id": playlist_id},
        )

    items = [normalize_playlist_item(entry, i) for i, entry in enumerate(entries)]
    playlist = normalize_playlist(meta, me)
    playlist["item_count"] = len(items)

    warnings = []
    # Compensate snapshot_id read lag after our own writes. Only for market-less reads, whose URIs
    # are exactly the stored ones (a market could relink URIs and break the comparison).
    if market is None and client.write_log is not None:
        read_snapshot = playlist["snapshot_id"]
        effective, lagging = client.write_log.resolve(playlist_id, read_snapshot, [i["uri"] for i in items])
        if lagging:
            playlist["snapshot_id"] = effective
            warnings.append(
                {
                    "code": "SNAPSHOT_READ_LAG",
                    "message": "Spotify returned a stale snapshot_id; using the one returned by spotikit's "
                    "last write to this playlist (items match exactly).",
                    "read_snapshot_id": read_snapshot,
                    "effective_snapshot_id": effective,
                }
            )
    local = [i["position"] for i in items if i["is_local"]]
    if local:
        warnings.append({"code": "LOCAL_FILES", "message": "Playlist contains local files.", "positions": local})
    unavailable = [i["position"] for i in items if i["uri"] is None]
    if unavailable:
        warnings.append(
            {"code": "UNAVAILABLE_ITEMS", "message": "Some items have no track object.", "positions": unavailable}
        )
    return {"playlist": playlist, "items": items, "warnings": warnings}


def require_editable(playlist: dict[str, Any]) -> None:
    if not (playlist["owned"] or playlist["collaborative"]):
        raise Forbidden(
            "You can only modify playlists you own or collaborate on.",
            details={"playlist_id": playlist["id"], "owner_id": playlist["owner_id"]},
        )


def create_playlist(
    client: SpotifyClient,
    name: str,
    description: str = "",
    public: bool = False,
    allow_duplicate_name: bool = False,
) -> dict[str, Any]:
    name = name.strip()
    if not name:
        raise InvalidArgument("Playlist name cannot be empty.")
    if not allow_duplicate_name:
        existing = [
            p
            for p in list_playlists(client, owned_only=True)["playlists"]
            if (p["name"] or "").strip().casefold() == name.casefold()
        ]
        if existing:
            raise DuplicateName(
                "You already own a playlist with this name. Pass --allow-duplicate-name to create it anyway.",
                details={"existing": [{"id": p["id"], "name": p["name"], "url": p["url"]} for p in existing]},
            )
    body: dict[str, Any] = {"name": name, "public": public}
    if description:
        body["description"] = description
    created = client.post("/me/playlists", body)
    if client.write_log is not None and created.get("snapshot_id"):
        client.write_log.record(created["id"], created["snapshot_id"], [])
    return {"playlist": normalize_playlist(created, client.current_user_id())}


def add_items(
    client: SpotifyClient,
    ref: str,
    item_refs: list[str],
    position: int | None = None,
    allow_duplicates: bool = False,
) -> dict[str, Any]:
    uris = [normalize_item_uri(r) for r in item_refs]
    if not uris:
        raise InvalidArgument("No items to add.")

    state = get_playlist(client, ref)
    playlist = state["playlist"]
    require_editable(playlist)
    count = len(state["items"])
    if position is not None and not 0 <= position <= count:
        raise InvalidArgument("Position is out of range.", details={"position": position, "item_count": count})

    present = {item["uri"] for item in state["items"]}
    to_add: list[str] = []
    skipped: list[dict[str, str]] = []
    for uri in uris:
        if not allow_duplicates and uri in present:
            skipped.append({"uri": uri, "reason": "already_in_playlist"})
        elif not allow_duplicates and uri in to_add:
            skipped.append({"uri": uri, "reason": "duplicate_in_input"})
        else:
            to_add.append(uri)

    snapshot_id = playlist["snapshot_id"]
    insert_at = position
    for chunk in chunks(to_add, MAX_URIS_PER_REQUEST):
        snapshot_id = _writes.insert_uris(client, playlist["id"], chunk, insert_at)
        if insert_at is not None:
            insert_at += len(chunk)

    start = position if position is not None else count
    if to_add and client.write_log is not None:
        expected = [item["uri"] for item in state["items"]]
        expected[start:start] = to_add
        client.write_log.record(playlist["id"], snapshot_id, expected)
    return {
        "playlist_id": playlist["id"],
        "added": [{"uri": uri, "position": start + i} for i, uri in enumerate(to_add)],
        "skipped": skipped,
        "item_count": count + len(to_add),
        "snapshot_id": snapshot_id,
    }
