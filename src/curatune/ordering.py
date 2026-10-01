"""Deterministic sort orders for reorder plans: title, artist, album, released, duration.

Computed here, not by the agent: models sort long lists unreliably (spotikit-web's evaluation). The
rules match spotikit-web's `sortedOrder` (an `Intl.Collator("en", {sensitivity: "base", numeric: true})`),
written out so both projects can test the same cases:

- Text keys are the title, the **first** artist, and the album name.
- Leading characters that are neither letters nor digits are ignored ("'Round Midnight" sorts as
  "Round Midnight"), then one leading English article "The " (any case). No other article, in any
  language, is ignored.
- Case and accents are ignored: "Á" equals "a" (Unicode NFKD, combining marks dropped, casefold).
- Runs of digits compare as numbers ("Track 2" before "Track 10"), and before letters.
- `released` compares the edition's release date as text ("1945" before "1945-11-26"); `duration`
  compares milliseconds.
- Items without a value go last, in both directions.
- Ties keep their current order, in both directions: `descending` reverses the comparison, not the
  tie-break.

Known divergence from the web's ICU collation: the relative order of punctuation and symbols inside
names, and of non-Latin scripts, can differ.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

SORT_KEYS = ("title", "artist", "album", "released", "duration")

_LEADING_NON_ALNUM = re.compile(r"^[\W_]+", re.UNICODE)
_LEADING_THE = re.compile(r"^the\s+", re.IGNORECASE)
_DIGITS = re.compile(r"(\d+)")


def text_key(value: str) -> tuple[tuple[int, Any], ...]:
    """Comparison key for a name, following the rules above."""
    text = _LEADING_THE.sub("", _LEADING_NON_ALNUM.sub("", value))
    folded = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c)).casefold()
    parts = []
    for i, part in enumerate(_DIGITS.split(folded)):
        if not part:
            continue
        parts.append((0, int(part)) if i % 2 else (1, part))  # split() puts digit runs at odd indexes
    return tuple(parts)


def _value(item: dict[str, Any], key: str) -> Any:
    if key == "title":
        return text_key(item["name"]) if item.get("name") is not None else None
    if key == "artist":
        artists = item.get("artists") or []
        name = artists[0].get("name") if artists else None
        return text_key(name) if name is not None else None
    if key == "album":
        name = (item.get("album") or {}).get("name")
        return text_key(name) if name is not None else None
    if key == "released":
        return (item.get("album") or {}).get("release_date")
    if key == "duration":
        return item.get("duration_ms")
    raise ValueError(f"unknown sort key: {key}")


def sorted_order(items: list[dict[str, Any]], key: str, descending: bool = False) -> list[int]:
    """New order (as current 0-based positions) of playlist items sorted by `key`."""
    keyed = [(_value(item, key), item["position"]) for item in sorted(items, key=lambda i: i["position"])]
    with_value = [(v, p) for v, p in keyed if v is not None]
    without = [p for v, p in keyed if v is None]
    # Python's sort is stable, also with reverse=True: equal values keep their current order.
    with_value.sort(key=lambda vp: vp[0], reverse=descending)
    return [p for _, p in with_value] + without
