"""The only place where 0-based positions become 1-based track numbers, and back.

The library, plan files, the CLI, and docs/reference.md use 0-based positions, like the Spotify API.
What the model sees through MCP uses `number`, 1-based, like the track numbers in the Spotify app:
small models confuse 0-based positions with track numbers (spotikit-web's evaluation), and every
model talks to the user in 1-based numbers anyway.

Conversion happens once, at the MCP boundary:
- inbound, `to_position()` turns a number argument into a position;
- outbound, `numbered()` renames every position-carrying key in a result, warning, or error detail.
A result that still carries a `position` key after `numbered()` is a bug; tests check every tool.
"""

from __future__ import annotations

from typing import Any

# Keys that hold 0-based playlist positions, and the 1-based key each becomes.
POSITION_KEYS = {
    "position": "number",  # an item's position (items, added tracks, error details)
    "positions": "numbers",  # lists of positions (warnings such as LOCAL_FILES, error details)
    "from_position": "was",  # where a moved item came from (plan views)
}


def to_number(position: int) -> int:
    return position + 1


def to_position(number: int) -> int:
    return number - 1


def numbered(value: Any) -> Any:
    """A copy of `value` with every position key renamed to its number key and shifted by one."""
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if key in POSITION_KEYS:
                out[POSITION_KEYS[key]] = _shift(item)
            else:
                out[key] = numbered(item)
        return out
    if isinstance(value, list):
        return [numbered(item) for item in value]
    return value


def _shift(value: Any) -> Any:
    if isinstance(value, bool):  # bool is an int subclass; never a position
        return value
    if isinstance(value, int):
        return to_number(value)
    if isinstance(value, list):
        return [_shift(v) for v in value]
    return value
