"""create_playlist must report the visibility Spotify actually has, not the one it echoes back."""

import pytest

from curatune import playlists
from curatune.errors import DuplicateName

NEW_ID = "NeWpLaYlIsTiD000000000"  # synthetic, 22 chars


class FakeCreate:
    write_log = None

    def __init__(self, actual_public: bool, existing: list[str] = ()):
        self.actual_public = actual_public
        self.existing = list(existing)
        self.posted = None

    def current_user_id(self):
        return "me"

    def paginate(self, path, **params):
        assert path == "/me/playlists"
        for name in self.existing:
            yield {"id": "x" * 22, "name": name, "owner": {"id": "me"}, "external_urls": {}}

    def post(self, path, body):
        assert path == "/me/playlists"
        self.posted = body
        # Echoes the requested visibility, like the real API does.
        return {"id": NEW_ID, "name": body["name"], "public": body["public"], "owner": {"id": "me"},
                "snapshot_id": "snap-1", "external_urls": {}}  # fmt: skip

    def get(self, path, **params):
        assert path == f"/playlists/{NEW_ID}"
        return {"public": self.actual_public}


def test_private_request_ignored_by_spotify_is_reported():
    fake = FakeCreate(actual_public=True)
    result = playlists.create_playlist(fake, "Test")
    assert fake.posted["public"] is False
    assert result["playlist"]["public"] is True
    assert result["visibility"] == {"requested_public": False, "reported_public": True}
    assert result["warnings"][0]["code"] == "VISIBILITY_NOT_APPLIED"


def test_private_reported_is_still_flagged_as_unverified():
    result = playlists.create_playlist(FakeCreate(actual_public=False), "Test")
    assert result["playlist"]["public"] is False
    assert result["warnings"][0]["code"] == "VISIBILITY_UNVERIFIED"


def test_public_request_has_no_visibility_warning():
    result = playlists.create_playlist(FakeCreate(actual_public=True), "Test", public=True)
    assert result["warnings"] == []


def test_duplicate_name_is_rejected_before_creating():
    fake = FakeCreate(actual_public=True, existing=["  test "])
    with pytest.raises(DuplicateName):
        playlists.create_playlist(fake, "Test")
    assert fake.posted is None
