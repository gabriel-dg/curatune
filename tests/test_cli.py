import json

from spotikit import cli


def _run(capsys, argv):
    code = cli.main(argv)
    return code, json.loads(capsys.readouterr().out)


def test_usage_error_is_json(capsys):
    code, out = _run(capsys, ["plan", "reorder", "x"])
    assert code == 2
    assert out["ok"] is False and out["error"]["code"] == "USAGE_ERROR"


def test_plan_show_missing_plan_is_json_error(capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("SPOTIKIT_PROJECT_DIR", str(tmp_path / "repo"))
    monkeypatch.setenv("SPOTIKIT_TOKEN_DIR", str(tmp_path / "tokens"))
    code, out = _run(capsys, ["plan", "show", "nope"])
    assert code == 1
    assert out["error"]["code"] == "PLAN_NOT_FOUND"


def test_auth_status_logged_out(capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("SPOTIKIT_PROJECT_DIR", str(tmp_path / "repo"))
    monkeypatch.setenv("SPOTIKIT_TOKEN_DIR", str(tmp_path / "tokens"))
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
