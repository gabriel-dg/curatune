"""Local record of curatune's own writes, used to compensate Spotify's snapshot_id read lag.

After a write, `GET /playlists/{id}` keeps returning the previous snapshot_id for a few minutes,
while the item list is already current. The snapshot returned by the write itself is the one
reads eventually converge to. Recording it (with the item URIs we expect after the write) lets
us recognize a lagging read: same items as recorded, different snapshot, recent write.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

# Lag observed live was a few minutes; entries older than this are ignored.
ENTRY_TTL_SECONDS = 15 * 60


class WriteLog:
    def __init__(self, path: Path, ttl_seconds: float = ENTRY_TTL_SECONDS):
        self.path = path
        self.ttl_seconds = ttl_seconds

    def _load(self) -> dict[str, Any]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _save(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def record(self, playlist_id: str, snapshot_id: str, uris: list[str | None]) -> None:
        data = self._load()
        data[playlist_id] = {"snapshot_id": snapshot_id, "uris": uris, "recorded_at": time.time()}
        self._save(data)

    def forget(self, playlist_id: str) -> None:
        data = self._load()
        if data.pop(playlist_id, None) is not None:
            self._save(data)

    def expected_counts(self) -> dict[str, int]:
        """Item counts expected after curatune's recent writes, by playlist id.

        The playlist list lags behind writes too: `GET /me/playlists` keeps the old `items.total` for a
        while. `playlists list` prefers these counts while they differ. Entries are not dropped here;
        only a full read (`resolve`) can tell whether a playlist moved on.
        """
        now = time.time()
        return {
            playlist_id: len(entry["uris"])
            for playlist_id, entry in self._load().items()
            if now - entry["recorded_at"] <= self.ttl_seconds
        }

    def resolve(self, playlist_id: str, read_snapshot: str, read_uris: list[str | None]) -> tuple[str, bool]:
        """Return (effective snapshot_id, read_is_lagging).

        The read is considered lagging only if we wrote to this playlist recently, the items read
        match exactly what we expect after that write, and the snapshot read differs from the one
        the write returned. Once reads converge, the entry is dropped.
        """
        data = self._load()
        entry = data.get(playlist_id)
        if not entry:
            return read_snapshot, False
        if entry["snapshot_id"] == read_snapshot or time.time() - entry["recorded_at"] > self.ttl_seconds:
            self.forget(playlist_id)
            return read_snapshot, False
        if entry["uris"] == read_uris:
            return entry["snapshot_id"], True
        # Items diverged from what we wrote: the playlist moved on; the entry no longer applies.
        self.forget(playlist_id)
        return read_snapshot, False
