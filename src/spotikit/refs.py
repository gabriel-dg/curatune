"""Parsing of Spotify references: bare IDs, URIs (spotify:<kind>:<id>) and open.spotify.com URLs."""

from __future__ import annotations

import re
from urllib.parse import urlparse

from .errors import InvalidReference

KINDS = ("playlist", "track", "album", "artist", "episode")
_ID_RE = re.compile(r"^[A-Za-z0-9]{22}$")


def parse_id(ref: str, kind: str) -> str:
    """Return the 22-char Spotify ID of `ref`, which must refer to an object of `kind`."""
    if kind not in KINDS:
        raise ValueError(f"unsupported kind: {kind}")
    value = (ref or "").strip()

    if value.startswith("spotify:"):
        parts = value.split(":")
        if len(parts) == 3 and parts[1] == kind and _ID_RE.match(parts[2]):
            return parts[2]
        raise InvalidReference(f"Not a Spotify {kind} URI.", details={"ref": ref})

    if value.startswith(("http://", "https://")):
        parsed = urlparse(value)
        if parsed.netloc != "open.spotify.com":
            raise InvalidReference("Only open.spotify.com URLs are supported.", details={"ref": ref})
        # Paths look like /playlist/<id> or /intl-es/playlist/<id>.
        segments = [s for s in parsed.path.split("/") if s]
        if len(segments) >= 2 and segments[-2] == kind and _ID_RE.match(segments[-1]):
            return segments[-1]
        raise InvalidReference(f"Not a Spotify {kind} URL.", details={"ref": ref})

    if _ID_RE.match(value):
        return value
    raise InvalidReference(f"Cannot parse Spotify {kind} reference.", details={"ref": ref})


def to_uri(kind: str, spotify_id: str) -> str:
    return f"spotify:{kind}:{spotify_id}"


def normalize_item_uri(ref: str) -> str:
    """Normalize a track or episode reference (ID defaults to track) to its URI."""
    value = (ref or "").strip()
    if value.startswith("spotify:local:"):
        raise InvalidReference("Local files cannot be added through the API.", details={"ref": ref})
    for kind in ("track", "episode"):
        if value.startswith(f"spotify:{kind}:") or f"/{kind}/" in value:
            return to_uri(kind, parse_id(value, kind))
    return to_uri("track", parse_id(value, "track"))
