import pytest

from spotikit.errors import InvalidReference
from spotikit.models import format_duration, normalize_playlist_item
from spotikit.refs import normalize_item_uri, parse_id

PID = "AbCdEfGhIjKlMnOpQrStUv"  # synthetic


@pytest.mark.parametrize(
    "ref",
    [
        PID,
        f"spotify:playlist:{PID}",
        f"https://open.spotify.com/playlist/{PID}",
        f"https://open.spotify.com/playlist/{PID}?si=abc123",
        f"https://open.spotify.com/intl-es/playlist/{PID}",
    ],
)
def test_parse_playlist_refs(ref):
    assert parse_id(ref, "playlist") == PID


@pytest.mark.parametrize(
    "ref",
    [f"spotify:track:{PID}", f"https://open.spotify.com/track/{PID}", "not-an-id", f"https://evil.com/playlist/{PID}"],
)
def test_parse_rejects_wrong_kind_or_host(ref):
    with pytest.raises(InvalidReference):
        parse_id(ref, "playlist")


def test_normalize_item_uri():
    assert normalize_item_uri(PID) == f"spotify:track:{PID}"
    assert normalize_item_uri(f"https://open.spotify.com/episode/{PID}") == f"spotify:episode:{PID}"
    with pytest.raises(InvalidReference):
        normalize_item_uri("spotify:local:a:b:c:180")


def test_format_duration():
    assert format_duration(174_999) == "2:54"
    assert format_duration(200_000) == "3:20"
    assert format_duration(None) is None


def test_playlist_item_accepts_new_and_deprecated_field_names():
    obj = {"type": "track", "uri": "spotify:track:x", "name": "Ko-Ko", "duration_ms": 174_000,
           "external_ids": {"isrc": "USSAV0000001"}}  # fmt: skip
    new = normalize_playlist_item({"item": obj, "added_at": "t", "is_local": False}, 0)
    old = normalize_playlist_item({"track": obj, "added_at": "t", "is_local": False}, 0)
    assert new == old
    assert new["isrc"] == "USSAV0000001" and new["duration"] == "2:54" and new["position"] == 0


def test_unavailable_item_keeps_stable_keys():
    item = normalize_playlist_item({"item": None, "added_at": "t", "is_local": False}, 3)
    assert item["uri"] is None and item["position"] == 3 and item["artists"] == []
