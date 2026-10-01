"""Sort orders for reorder plans. Each case is a rule documented in `ordering.py` and docs/reference.md;
the table is written so spotikit-web can check the same vectors."""

import pytest

from curatune.ordering import SORT_KEYS, sorted_order, text_key


def items(*names, **fields):
    out = []
    for position, name in enumerate(names):
        item = {"position": position, "name": name, "artists": [], "album": {}, "duration_ms": None}
        for key, values in fields.items():
            item[key] = values[position]
        out.append(item)
    return out


@pytest.mark.parametrize(
    "rule, names, expected",
    [
        ("case is ignored", ["b", "A", "c"], [1, 0, 2]),
        ("accents are ignored", ["Zebra", "Ángel", "apple"], [1, 2, 0]),
        ("a leading 'The ' is ignored", ["The Zoo", "Apple", "Then"], [1, 2, 0]),
        ("only English 'The', and only as a word", ["The Zoo", "Los Zorros", "La Abeja", "Thelonious"], [2, 1, 3, 0]),
        ("leading punctuation is ignored", ["'Round Midnight", "Manteca", "...Blue Monk"], [2, 1, 0]),
        ("punctuation, then 'The'", ["'The Zoo", "Yardbird"], [1, 0]),
        ("digit runs compare as numbers", ["Track 10", "Track 2", "Track 1"], [2, 1, 0]),
        ("digits come before letters", ["a", "1"], [1, 0]),
        ("equal under these rules: current order", ["b", "A", "a", "B"], [1, 2, 0, 3]),
        ("an empty key sorts first", ["Bebop", "!!!"], [1, 0]),
    ],
)
def test_title_rules(rule, names, expected):
    assert sorted_order(items(*names), "title") == expected, rule


def test_descending_reverses_the_comparison_not_the_ties():
    assert sorted_order(items("b", "A", "a", "B"), "title", descending=True) == [0, 3, 1, 2]


@pytest.mark.parametrize("descending", [False, True])
def test_items_without_a_value_go_last_in_both_directions(descending):
    data = items("b", None, "a", None)
    order = sorted_order(data, "title", descending=descending)
    assert order[2:] == [1, 3]  # missing values last, in their current order
    assert order[:2] == ([0, 2] if descending else [2, 0])


def test_artist_uses_the_first_artist():
    data = items("x", "y", "z", artists=[[{"name": "Monk"}, {"name": "Art Blakey"}], [{"name": "Bird"}], []])
    assert sorted_order(data, "artist") == [1, 0, 2]  # no artist: last


def test_album_released_and_duration():
    data = items(
        "x", "y", "z",
        album=[{"name": "The Savoy Sessions", "release_date": "1951"},
               {"name": "Birth of the Cool", "release_date": "1945-11-26"},
               {"name": "Groovin' High", "release_date": "1945"}],
        duration_ms=[196000, 174000, None],
    )  # fmt: skip
    assert sorted_order(data, "album") == [1, 2, 0]  # "Savoy" (The ignored) after "Groovin'"
    assert sorted_order(data, "released") == [2, 1, 0]  # "1945" before "1945-11-26"
    assert sorted_order(data, "duration") == [1, 0, 2]
    assert sorted_order(data, "duration", descending=True) == [0, 1, 2]


def test_text_key_is_case_and_accent_insensitive():
    assert text_key("Café Bohème") == text_key("CAFE BOHEME")
    assert text_key("The Freedom Suite") == text_key("freedom suite")


def test_keys_and_unknown_key():
    assert SORT_KEYS == ("title", "artist", "album", "released", "duration")
    with pytest.raises(ValueError):
        sorted_order(items("a"), "popularity")
