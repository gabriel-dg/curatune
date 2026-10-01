"""add_items reads the playlist back: it confirms the result and names what was added."""

from curatune import playlists
from curatune.errors import RateLimited

from .fakes import PLAYLIST_ID, FakeSpotify, track_uri


class CountingFake(FakeSpotify):
    reads = 0

    def paginate(self, path, **params):
        if path.endswith("/items"):
            self.reads += 1
        yield from super().paginate(path, **params)


def test_added_items_are_verified_and_named():
    fake = FakeSpotify([track_uri(1), track_uri(2)])
    result = playlists.add_items(fake, PLAYLIST_ID, [track_uri(10), track_uri(11)])
    assert result["verified"] is True and result["warnings"] == []
    assert result["added"] == [
        {"uri": track_uri(10), "position": 2, "name": "Track 10", "artists": ["Artist"]},
        {"uri": track_uri(11), "position": 3, "name": "Track 11", "artists": ["Artist"]},
    ]
    assert result["item_count"] == 4


def test_insert_position_is_named_from_the_read_back():
    fake = FakeSpotify([track_uri(1), track_uri(2)])
    result = playlists.add_items(fake, PLAYLIST_ID, [track_uri(10)], position=1)
    assert fake.uris == [track_uri(1), track_uri(10), track_uri(2)]
    assert result["added"] == [{"uri": track_uri(10), "position": 1, "name": "Track 10", "artists": ["Artist"]}]


def test_nothing_to_add_needs_no_read_back():
    fake = CountingFake([track_uri(1)])
    result = playlists.add_items(fake, PLAYLIST_ID, [track_uri(1)])
    assert result["added"] == [] and result["skipped"] == [{"uri": track_uri(1), "reason": "already_in_playlist"}]
    assert result["verified"] is True
    assert fake.reads == 1  # only the read before writing
    assert fake.mutations == []


class ConcurrentEditFake(FakeSpotify):
    """Someone else adds a track in the Spotify app right after our write."""

    def post(self, path, body):
        result = super().post(path, body)
        self.uris.append(track_uri(99))
        return result


def test_a_concurrent_change_is_reported_not_hidden():
    fake = ConcurrentEditFake([track_uri(1)])
    result = playlists.add_items(fake, PLAYLIST_ID, [track_uri(10)])
    assert result["verified"] is False
    assert [w["code"] for w in result["warnings"]] == ["ADD_NOT_VERIFIED"]
    assert result["warnings"][0]["expected_item_count"] == 2 and result["warnings"][0]["read_item_count"] == 3
    # The added track is still where we put it, so it is still named.
    assert result["added"][0]["name"] == "Track 10"


class MisplacedFake(FakeSpotify):
    """The read-back shows something else at the position we wrote to."""

    def post(self, path, body):
        result = super().post(path, body)
        self.uris.insert(0, track_uri(99))
        return result


def test_unconfirmed_items_are_not_given_a_wrong_name():
    fake = MisplacedFake([track_uri(1)])
    result = playlists.add_items(fake, PLAYLIST_ID, [track_uri(10)])
    assert result["verified"] is False
    assert result["added"] == [{"uri": track_uri(10), "position": 1, "name": None, "artists": []}]


class ReadBackFails(FakeSpotify):
    """The tracks are added, then reading the playlist back fails (rate limit, a transient error)."""

    def __init__(self, uris):
        super().__init__(uris)
        self.item_reads = 0

    def paginate(self, path, **params):
        if path.endswith("/items"):
            self.item_reads += 1
            if self.item_reads == 2:
                raise RateLimited("Spotify rate limit reached.", details={"retry_after_seconds": 120})
        yield from super().paginate(path, **params)


def test_a_failed_read_back_is_unverified_not_a_failure():
    fake = ReadBackFails([track_uri(1)])
    result = playlists.add_items(fake, PLAYLIST_ID, [track_uri(10)])
    assert fake.uris == [track_uri(1), track_uri(10)]  # the write happened
    assert result["verified"] is False
    assert result["warnings"] == [
        {"code": "ADD_NOT_VERIFIED", "message": result["warnings"][0]["message"], "read_error": "RATE_LIMITED"}
    ]
    assert result["added"] == [{"uri": track_uri(10), "position": 1, "name": None, "artists": []}]
