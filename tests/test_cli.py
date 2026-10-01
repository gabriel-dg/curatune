import json

import pytest

from curatune import catalog, cli

from .fakes import PLAYLIST_ID, FakeSpotify, track_uri


@pytest.fixture
def offline_settings(monkeypatch, tmp_path):
    monkeypatch.setenv("CURATUNE_PROJECT_DIR", str(tmp_path / "repo"))
    monkeypatch.setenv("CURATUNE_TOKEN_DIR", str(tmp_path / "tokens"))
    monkeypatch.delenv("CURATUNE_MARKET", raising=False)


BRIEF_KEYS = {"uri", "name", "artists", "album", "released", "duration", "isrc", "playable"}


def test_playlist_show_brief_is_flat(capsys, monkeypatch, offline_settings):
    fake = FakeSpotify([track_uri(1), track_uri(2)])
    monkeypatch.setattr(cli, "_client", lambda s: fake)
    code, out = _run(capsys, ["playlist", "show", PLAYLIST_ID, "--brief"])
    assert code == 0
    items = out["data"]["items"]
    assert set(items[0]) == BRIEF_KEYS | {"position"}
    assert items[1]["position"] == 1 and items[0]["artists"] == ["Artist"] and items[0]["album"] == "Album"
    assert out["data"]["playlist"]["id"] == PLAYLIST_ID


def test_batch_search_brief_keeps_errors(capsys, monkeypatch, offline_settings, tmp_path):
    track = {"uri": "spotify:track:x", "name": "Rain", "artists": [{"name": "The Beatles", "uri": "u"}],
             "album": {"name": "Revolver", "release_date": "2022-10-28"}, "duration": "2:59"}  # fmt: skip
    canned = {"count": 2, "failed": 1, "searches": [
        {"id": "a", "ok": True, "results": [track]},
        {"id": "b", "ok": False, "error": {"code": "NOT_FOUND", "message": "x", "details": {}}},
    ]}  # fmt: skip
    monkeypatch.setattr(cli, "_client", lambda s: None)
    monkeypatch.setattr(catalog, "search_tracks_batch", lambda *a, **k: canned)
    queries = tmp_path / "q.json"
    queries.write_text("[]")
    code, out = _run(capsys, ["search", "tracks", "--from-file", str(queries), "--brief"])
    assert code == 0
    first = out["data"]["searches"][0]["results"][0]
    assert set(first) == BRIEF_KEYS
    assert first["artists"] == ["The Beatles"] and first["album"] == "Revolver" and first["released"] == "2022-10-28"
    assert out["data"]["searches"][1]["error"]["code"] == "NOT_FOUND"


def _run(capsys, argv):
    code = cli.main(argv)
    return code, json.loads(capsys.readouterr().out)


def test_usage_error_is_json(capsys):
    code, out = _run(capsys, ["plan", "reorder", "x"])
    assert code == 2
    assert out["ok"] is False and out["error"]["code"] == "USAGE_ERROR"


def test_plan_show_missing_plan_is_json_error(capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("CURATUNE_PROJECT_DIR", str(tmp_path / "repo"))
    monkeypatch.setenv("CURATUNE_TOKEN_DIR", str(tmp_path / "tokens"))
    code, out = _run(capsys, ["plan", "show", "nope"])
    assert code == 1
    assert out["error"]["code"] == "PLAN_NOT_FOUND"


def test_auth_status_logged_out(capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("CURATUNE_PROJECT_DIR", str(tmp_path / "repo"))
    monkeypatch.setenv("CURATUNE_TOKEN_DIR", str(tmp_path / "tokens"))
    code, out = _run(capsys, ["auth", "status"])
    assert code == 0
    meta = out.pop("meta")
    assert meta["http"] == {} and meta["elapsed_ms"] >= 0
    assert out == {
        "schema_version": 1,
        "ok": True,
        "command": "auth status",
        "data": {"logged_in": False, "token_path": str(tmp_path / "tokens" / "token.json")},
        "warnings": [],
    }


def test_plan_reorder_sort_by(capsys, monkeypatch, offline_settings):
    fake = FakeSpotify([track_uri(3), track_uri(1), track_uri(2)])
    monkeypatch.setattr(cli, "_client", lambda s: fake)
    code, out = _run(capsys, ["plan", "reorder", PLAYLIST_ID, "--sort-by", "title", "--descending"])
    assert code == 0
    assert out["data"]["changes"]["new_order"] == [0, 2, 1]
    code, out = _run(capsys, ["plan", "reorder", PLAYLIST_ID, "--order", "1,0,2", "--descending"])
    assert code == 1 and out["error"]["code"] == "PLAN_INVALID"
    code, out = _run(capsys, ["plan", "reorder", PLAYLIST_ID, "--sort-by", "popularity"])
    assert code == 2 and out["error"]["code"] == "USAGE_ERROR"
