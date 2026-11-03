"""The 0-based ↔ 1-based conversion at the MCP boundary. Pure; runs without the `mcp` extra."""

import pytest

from curatune.mcp_server.numbering import POSITION_KEYS, numbered, to_number, to_position


@pytest.mark.parametrize("position", [0, 1, 41])
def test_round_trip(position):
    assert to_position(to_number(position)) == position
    assert to_number(position) == position + 1


def test_item_positions_become_numbers():
    items = [{"position": 0, "uri": "a", "name": "Ko-Ko"}, {"position": 6, "uri": "b", "name": "Manteca"}]
    assert numbered(items) == [{"number": 1, "uri": "a", "name": "Ko-Ko"}, {"number": 7, "uri": "b", "name": "Manteca"}]


@pytest.mark.parametrize(
    "warning, expected",
    [
        (
            {"code": "LOCAL_FILES", "message": "m", "positions": [0, 3]},
            {"code": "LOCAL_FILES", "message": "m", "numbers": [1, 4]},
        ),
        (
            {"code": "UNAVAILABLE_ITEMS", "message": "m", "positions": [2]},
            {"code": "UNAVAILABLE_ITEMS", "message": "m", "numbers": [3]},
        ),
    ],
)
def test_warning_positions_become_numbers(warning, expected):
    assert numbered([warning]) == [expected]


def test_nested_error_details_are_converted():
    error = {
        "code": "RECORDING_DATES_MISSING",
        "message": "m",
        "details": {"missing": [{"position": 4, "uri": "u", "name": "n"}]},
    }
    assert numbered(error)["details"]["missing"] == [{"number": 5, "uri": "u", "name": "n"}]
    add_error = {"code": "INVALID_ARGUMENT", "message": "m", "details": {"position": 9, "item_count": 7}}
    assert numbered(add_error)["details"] == {"number": 10, "item_count": 7}  # counts are not positions


def test_moved_items_say_where_they_were():
    assert numbered({"position": 0, "from_position": 5, "uri": "u"}) == {"number": 1, "was": 6, "uri": "u"}


def test_other_keys_and_values_are_left_alone():
    track = {"track_number": 3, "disc_number": 1, "duration_ms": 1000, "name": "position 2", "explicit": False}
    assert numbered(track) == track
    assert numbered({"position": None}) == {"number": None}  # an unknown position stays unknown
    assert numbered({"positions": [True]}) == {"numbers": [True]}  # booleans are never shifted


def test_input_is_not_modified():
    item = {"position": 0, "artists": [{"name": "x"}]}
    numbered(item)
    assert item == {"position": 0, "artists": [{"name": "x"}]}


def test_every_position_key_has_a_distinct_number_key():
    assert len(set(POSITION_KEYS.values())) == len(POSITION_KEYS)
    assert not set(POSITION_KEYS) & set(POSITION_KEYS.values())
