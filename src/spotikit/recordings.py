"""Local store of recording metadata, keyed by track URI.

Spotify only exposes the release date of an edition, not when a track was recorded. Recording
dates come from discographies or other sources and are stored in `data/recordings.json`
(gitignored) together with their source and confidence. The store is data, not judgment:
deciding a date is the caller's job; this module only validates, stores, and joins it.

Entry shape:
    {"recorded": "1947-12-05" | "1947-12" | "1947", "confidence": "high" | "medium" | "low",
     "source": "...", "note": "...", "name": "...", "artists": [...], "isrc": "..."}
"""

from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path
from typing import Any

from .errors import InvalidArgument, PlanError
from .http import SpotifyClient
from .playlists import get_playlist
from .refs import normalize_item_uri

CONFIDENCE_LEVELS = ("high", "medium", "low")
_DATE_RE = re.compile(r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$")
_OPTIONAL_TEXT = ("note", "name", "isrc")


def validate_recorded(value: Any) -> str:
    match = _DATE_RE.match(value) if isinstance(value, str) else None
    if not match:
        raise InvalidArgument("recorded must be YYYY, YYYY-MM, or YYYY-MM-DD.", details={"recorded": value})
    year, month, day = (int(g) if g else None for g in match.groups())
    try:
        date(year, month or 1, day or 1)
    except ValueError:
        raise InvalidArgument("recorded is not a valid date.", details={"recorded": value}) from None
    return value


def validate_entry(raw: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Validate one input entry; returns (uri, normalized entry)."""
    if not isinstance(raw, dict) or "uri" not in raw:
        raise InvalidArgument("Each recording entry must be an object with a 'uri'.", details={"entry": raw})
    uri = normalize_item_uri(raw["uri"])
    confidence = raw.get("confidence")
    if confidence not in CONFIDENCE_LEVELS:
        raise InvalidArgument(
            f"confidence must be one of {', '.join(CONFIDENCE_LEVELS)}.", details={"uri": uri, "confidence": confidence}
        )
    source = raw.get("source")
    if not isinstance(source, str) or not source.strip():
        raise InvalidArgument("source is required (where the date comes from).", details={"uri": uri})
    entry: dict[str, Any] = {
        "recorded": validate_recorded(raw.get("recorded")),
        "confidence": confidence,
        "source": source.strip(),
    }
    for key in _OPTIONAL_TEXT:
        if raw.get(key):
            entry[key] = str(raw[key])
    if raw.get("artists"):
        entry["artists"] = [str(a) for a in raw["artists"]]
    return uri, entry


class RecordingStore:
    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict[str, dict[str, Any]]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except json.JSONDecodeError as exc:
            raise InvalidArgument("The recordings store is not valid JSON.", details={"path": str(self.path), "error": str(exc)}) from None

    def save(self, data: dict[str, dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True), encoding="utf-8")
        tmp.replace(self.path)

    def upsert(self, raw_entries: list[dict[str, Any]]) -> dict[str, Any]:
        if not isinstance(raw_entries, list) or not raw_entries:
            raise InvalidArgument("Expected a non-empty JSON array of recording entries.")
        validated = [validate_entry(raw) for raw in raw_entries]  # all-or-nothing
        data = self.load()
        created = [uri for uri, _ in validated if uri not in data]
        for uri, entry in validated:
            data[uri] = entry
        self.save(data)
        return {"created": len(created), "updated": len(validated) - len(created), "total": len(data), "path": str(self.path)}


def _lookup(data: dict[str, dict[str, Any]], uri: str | None, isrc: str | None) -> tuple[dict[str, Any] | None, str | None]:
    if uri and uri in data:
        return data[uri], "uri"
    if isrc:
        for entry in data.values():
            if entry.get("isrc") == isrc:
                return entry, "isrc"
    return None, None


def playlist_recordings(client: SpotifyClient, store: RecordingStore, ref: str) -> dict[str, Any]:
    """Join a playlist's items with the store. Items without a recording date are listed in `missing`."""
    state = get_playlist(client, ref)  # no market: URIs exactly as stored in the playlist
    data = store.load()
    items = []
    for item in state["items"]:
        entry, matched_by = _lookup(data, item["uri"], item.get("isrc"))
        items.append(
            {
                "position": item["position"],
                "uri": item["uri"],
                "name": item["name"],
                "artists": [a["name"] for a in item["artists"]],
                "isrc": item.get("isrc"),
                "recording": entry,
                "matched_by": matched_by,
            }
        )
    missing = [{"position": i["position"], "uri": i["uri"], "name": i["name"]} for i in items if i["recording"] is None]
    dated = [i["recording"]["recorded"] for i in items if i["recording"]]
    return {
        "playlist": state["playlist"],
        "items": items,
        "missing": missing,
        "chronological": not missing and dated == sorted(dated),
        "warnings": state["warnings"],
    }


def chronological_order(items: list[dict[str, Any]], data: dict[str, dict[str, Any]]) -> list[int]:
    """New order (as current positions) sorted by recording date; ties keep their current order."""
    keyed = []
    missing = []
    for item in items:
        entry, _ = _lookup(data, item["uri"], item.get("isrc"))
        if entry is None:
            missing.append({"position": item["position"], "uri": item["uri"], "name": item["name"]})
        else:
            keyed.append((entry["recorded"], item["position"]))
    if missing:
        raise PlanError(
            "Some items have no recording date; add them with `recordings set` first.",
            code="RECORDING_DATES_MISSING",
            details={"missing": missing},
        )
    return [position for _, position in sorted(keyed)]
