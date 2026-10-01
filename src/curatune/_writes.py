"""Low-level mutating calls on playlist items.

Private on purpose: removals and reorders must only happen through `plans.apply_plan`, which
validates the plan against the live playlist first. `insert_uris` is also used by
`playlists.add_items`, since additions are allowed without a plan.
"""

from __future__ import annotations

from .http import SpotifyClient


def insert_uris(client: SpotifyClient, playlist_id: str, uris: list[str], position: int | None = None) -> str:
    body: dict = {"uris": uris}
    if position is not None:
        body["position"] = position
    return client.post(f"/playlists/{playlist_id}/items", body)["snapshot_id"]


def remove_uris(client: SpotifyClient, playlist_id: str, uris: list[str], snapshot_id: str) -> str:
    # The API takes URIs only (no positions): every occurrence of each URI is removed.
    body = {"items": [{"uri": uri} for uri in uris], "snapshot_id": snapshot_id}
    return client.delete(f"/playlists/{playlist_id}/items", body)["snapshot_id"]


DETAIL_FIELDS = ("name", "description")


def set_details(client: SpotifyClient, playlist_id: str, fields: dict[str, str]) -> None:
    # Only name and description, ever: visibility and collaboration are deliberately out of reach.
    if not fields or set(fields) - set(DETAIL_FIELDS):
        raise ValueError(f"set_details only accepts {DETAIL_FIELDS}, got {sorted(fields)}")
    client.put(f"/playlists/{playlist_id}", dict(fields))  # 200 with an empty body; returns no snapshot_id


def move_range(
    client: SpotifyClient,
    playlist_id: str,
    range_start: int,
    insert_before: int,
    range_length: int,
    snapshot_id: str,
) -> str:
    body = {
        "range_start": range_start,
        "insert_before": insert_before,
        "range_length": range_length,
        "snapshot_id": snapshot_id,
    }
    return client.put(f"/playlists/{playlist_id}/items", body)["snapshot_id"]
