"""Thin CLI over the curatune library. Every invocation prints exactly one JSON envelope to stdout.

Success: {"schema_version": 1, "ok": true, "command": "...", "data": {...}, "warnings": [...], "meta": {...}}
Failure: {"schema_version": 1, "ok": false, "command": "...", "error": {"code", "message", "details"}, "meta": {...}}
meta: {"elapsed_ms": <command time, excluding interpreter start-up>, "http": {"api"|"auth": {"calls", "ms"}}}
Exit codes: 0 ok, 1 curatune error, 2 usage error, 3 internal error, 130 interrupted.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable

from . import catalog, connect, datadir, metrics, playlists, plans, recordings
from .auth import TokenManager
from .config import Settings, load_settings
from .errors import InvalidArgument, PlanError, CuratuneError
from .http import SpotifyClient
from .models import brief_track
from .recordings import RecordingStore

OUTPUT_SCHEMA_VERSION = 1


class _UsageError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # type: ignore[override]
        raise _UsageError(message)


_started: float | None = None


def _emit(envelope: dict[str, Any]) -> None:
    if _started is not None:
        envelope["meta"] = {
            "elapsed_ms": round((time.perf_counter() - _started) * 1000, 1),
            "http": metrics.snapshot(),
        }
    sys.stdout.write(json.dumps(envelope, indent=2, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _client(settings: Settings) -> SpotifyClient:
    return connect(settings)


# --- Brief views (presentation only; the library always returns full objects) ---------------


def _brief_playlist(data: dict[str, Any]) -> dict[str, Any]:
    data["items"] = [brief_track(i) for i in data["items"]]
    return data


def _brief_search(data: dict[str, Any]) -> dict[str, Any]:
    if "searches" in data:
        for search in data["searches"]:
            if search.get("ok"):
                search["results"] = [brief_track(t) for t in search["results"]]
    else:
        data["results"] = [brief_track(t) for t in data["results"]]
    return data


def _brief_album(data: dict[str, Any]) -> dict[str, Any]:
    data["tracks"] = [brief_track(t) for t in data["tracks"]]
    return data


def _brief_recordings(data: dict[str, Any]) -> dict[str, Any]:
    data["items"] = [
        {
            "position": i["position"],
            "uri": i["uri"],
            "name": i["name"],
            "artists": i["artists"],
            "recorded": (i["recording"] or {}).get("recorded"),
            "confidence": (i["recording"] or {}).get("confidence"),
        }
        for i in data["items"]
    ]
    return data


def _read_text(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise InvalidArgument("Cannot read file.", details={"path": path, "error": str(exc)}) from None


def _read_json_file(path: str) -> Any:
    try:
        return json.loads(_read_text(path))
    except json.JSONDecodeError as exc:
        raise InvalidArgument("File is not valid JSON.", details={"path": path, "error": str(exc)}) from None


def _read_item_refs(args: argparse.Namespace) -> list[str]:
    refs = list(args.items or [])
    if args.from_file:
        text = _read_text(args.from_file)
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            data = [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]
        if not isinstance(data, list):
            raise InvalidArgument("--from-file JSON must be an array of URIs or of objects with a 'uri' key.")
        refs.extend(x["uri"] if isinstance(x, dict) else str(x) for x in data)
    return refs


def _read_order(args: argparse.Namespace) -> list[int] | None:
    if args.order is not None:
        try:
            raw: Any = [int(x) for x in args.order.split(",") if x.strip()]
        except ValueError:
            raise PlanError("--order must be comma-separated integers.", details={"order": args.order}) from None
    elif args.order_file:
        raw = _read_json_file(args.order_file)
        if isinstance(raw, dict):
            raw = raw.get("new_order")
    else:
        return None
    if not isinstance(raw, list) or not all(isinstance(x, int) for x in raw):
        raise PlanError("The order must be a JSON array of integers (0-based current positions).")
    return raw


def _parse_move(spec: str | None) -> tuple[int, int] | None:
    if spec is None:
        return None
    try:
        src, dst = (int(x) for x in spec.split(":"))
    except ValueError:
        raise PlanError("--move must look like FROM:TO (0-based positions).", details={"move": spec}) from None
    return src, dst


# --- Handlers ---------------------------------------------------------------------------------


def _auth_login(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    return TokenManager(s).login(port=args.port, open_browser=not args.no_browser, timeout=args.timeout)


def _auth_status(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    return {**TokenManager(s).status(), "data": datadir.status(s)}


def _data_migrate(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    return datadir.migrate(s, dry_run=args.dry_run)


def _auth_logout(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    return TokenManager(s).logout()


def _playlists_list(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    return playlists.list_playlists(_client(s), owned_only=args.owned_only)


def _playlist_show(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    data = playlists.get_playlist(_client(s), args.playlist, market=args.market or s.market)
    return _brief_playlist(data) if args.brief else data


def _playlist_create(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    return playlists.create_playlist(
        _client(s),
        args.name,
        description=args.description,
        public=args.public,
        allow_duplicate_name=args.allow_duplicate_name,
    )


def _playlist_add(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    return playlists.add_items(
        _client(s),
        args.playlist,
        _read_item_refs(args),
        position=args.position,
        allow_duplicates=args.allow_duplicates,
    )


def _search_tracks(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    data = _run_search(args, s)
    return _brief_search(data) if args.brief else data


def _run_search(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    if args.from_file:
        if args.query or any([args.track, args.artist, args.album, args.year]):
            raise InvalidArgument("--from-file cannot be combined with a query or filters; put them in the file.")
        return catalog.search_tracks_batch(
            _client(s), _read_json_file(args.from_file), market=args.market or s.market, workers=args.workers
        )
    return catalog.search_tracks(
        _client(s),
        args.query,
        track=args.track,
        artist=args.artist,
        album=args.album,
        year=args.year,
        limit=args.limit,
        offset=args.offset,
        market=args.market or s.market,
    )


def _track_show(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    return catalog.get_track(_client(s), args.track, market=args.market or s.market)


def _album_tracks(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    data = catalog.get_album_tracks(_client(s), args.album, market=args.market or s.market)
    return _brief_album(data) if args.brief else data


def _plan_remove(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    return plans.build_remove_plan(
        _client(s), args.playlist, plans.parse_positions(args.positions), s.plans_dir, reason=args.reason
    )


def _plan_reorder(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    sort_by = "recorded" if args.by_recording_date else args.sort_by
    return plans.build_reorder_plan(
        _client(s),
        args.playlist,
        s.plans_dir,
        new_order=_read_order(args),
        move=_parse_move(args.move),
        recordings=RecordingStore(s.recordings_path) if sort_by == "recorded" else None,
        reason=args.reason,
        sort_by=sort_by,
        descending=args.descending,
    )


def _plan_details(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    description = _read_text(args.description_file) if args.description_file else args.description
    return plans.build_details_plan(
        _client(s), args.playlist, s.plans_dir, name=args.name, description=description, reason=args.reason
    )


def _recordings_show(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    data = recordings.playlist_recordings(_client(s), RecordingStore(s.recordings_path), args.playlist)
    return _brief_recordings(data) if args.brief else data


def _recordings_set(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    return RecordingStore(s.recordings_path).upsert(_read_json_file(args.from_file))


def _plan_show(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    path = plans.resolve_plan_path(args.plan, s.plans_dir)
    return plans.show_plan(path, _client(s) if args.check else None)


def _plan_apply(args: argparse.Namespace, s: Settings) -> dict[str, Any]:
    path = plans.resolve_plan_path(args.plan, s.plans_dir)
    return plans.apply_plan(_client(s), path, s.backups_dir)


# --- Parser -----------------------------------------------------------------------------------


def _build_parser() -> _Parser:
    parser = _Parser(prog="curatune", description="A playlist toolkit for Spotify. Outputs JSON.")
    groups = parser.add_subparsers(dest="group", required=True, parser_class=_Parser)

    def command(group: argparse._SubParsersAction, name: str, handler: Callable, help_text: str) -> _Parser:
        sub = group.add_parser(name, help=help_text, description=help_text)
        sub.set_defaults(handler=handler)
        return sub

    def add_brief(sub: _Parser) -> None:
        sub.add_argument(
            "--brief",
            action="store_true",
            help="Compact flat items: position, uri, name, artists (names), album, released, duration, isrc, playable.",
        )

    # auth
    auth = groups.add_parser("auth", help="Authorization (OAuth PKCE).").add_subparsers(dest="action", required=True)
    p = command(auth, "login", _auth_login, "Run the browser authorization flow and store the token.")
    p.add_argument("--port", type=int, default=None, help="Callback port (default: SPOTIFY_REDIRECT_PORT or 8888).")
    p.add_argument("--no-browser", action="store_true", help="Do not open the browser; only print the URL to stderr.")
    p.add_argument("--timeout", type=float, default=300, help="Seconds to wait for the callback.")
    command(auth, "status", _auth_status, "Show the stored authorization (no network).")
    command(auth, "logout", _auth_logout, "Delete the stored token.")

    # data
    dat = groups.add_parser("data", help="The data directory.").add_subparsers(dest="action", required=True)
    p = command(
        dat,
        "migrate",
        _data_migrate,
        "Copy a checkout's data/ and plans/ into the data directory (backup first, then copy, then a SHA-256 "
        "check; never moves or overwrites).",
    )
    p.add_argument("--dry-run", action="store_true", help="List what would be copied; copy nothing.")

    # playlists
    pls = groups.add_parser("playlists", help="Playlist collections.").add_subparsers(dest="action", required=True)
    p = command(pls, "list", _playlists_list, "List the current user's playlists.")
    p.add_argument("--owned-only", action="store_true")

    # playlist
    pl = groups.add_parser("playlist", help="Single playlist operations.").add_subparsers(dest="action", required=True)
    p = command(pl, "show", _playlist_show, "Show playlist metadata and all items.")
    p.add_argument("playlist", help="Playlist ID, URI, or URL.")
    p.add_argument("--market")
    add_brief(p)
    p = command(pl, "create", _playlist_create, "Create a playlist (requests private by default).")
    p.add_argument("--name", required=True)
    p.add_argument("--description", default="")
    p.add_argument(
        "--public",
        action="store_true",
        help="Request a public playlist (default: request private; Spotify currently ignores that, see warnings).",
    )
    p.add_argument("--allow-duplicate-name", action="store_true")
    p = command(pl, "add", _playlist_add, "Add items (executes directly).")
    p.add_argument("playlist", help="Playlist ID, URI, or URL.")
    p.add_argument("items", nargs="*", help="Track/episode IDs, URIs, or URLs.")
    p.add_argument("--from-file", help="JSON array (strings or objects with 'uri') or one ref per line.")
    p.add_argument("--position", type=int, default=None, help="0-based insert position (default: append).")
    p.add_argument("--allow-duplicates", action="store_true")

    # search
    se = groups.add_parser("search", help="Catalog search.").add_subparsers(dest="action", required=True)
    p = command(se, "tracks", _search_tracks, "Search tracks (max 10 per request; paginate with --offset).")
    add_brief(p)
    p.add_argument("query", nargs="?", default=None, help="Free-text query.")
    p.add_argument("--track")
    p.add_argument("--artist")
    p.add_argument("--album")
    p.add_argument("--year", help="YYYY or YYYY-YYYY (release year of the edition).")
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--offset", type=int, default=0)
    p.add_argument("--market")
    p.add_argument(
        "--from-file",
        help='Batch mode: JSON array of queries {"id","query","track","artist","album","year","limit","offset","market"}.',
    )
    p.add_argument("--workers", type=int, default=catalog.BATCH_MAX_WORKERS, help="Batch mode concurrency (1-4).")

    # recordings
    rc = groups.add_parser("recordings", help="Local recording-date store.").add_subparsers(dest="action", required=True)
    p = command(rc, "show", _recordings_show, "Join a playlist's items with stored recording dates.")
    p.add_argument("playlist", help="Playlist ID, URI, or URL.")
    add_brief(p)
    p = command(rc, "set", _recordings_set, "Add or update recording entries (all-or-nothing validation).")
    p.add_argument(
        "--from-file",
        required=True,
        help='JSON array of {"uri","recorded","confidence","source", optional "note","name","artists","isrc"}.',
    )

    # track / album
    tr = groups.add_parser("track", help="Single track.").add_subparsers(dest="action", required=True)
    p = command(tr, "show", _track_show, "Show one track (includes ISRC).")
    p.add_argument("track", help="Track ID, URI, or URL.")
    p.add_argument("--market")
    al = groups.add_parser("album", help="Albums.").add_subparsers(dest="action", required=True)
    p = command(al, "tracks", _album_tracks, "List an album's tracks.")
    p.add_argument("album", help="Album ID, URI, or URL.")
    p.add_argument("--market")
    add_brief(p)

    # plan
    pn = groups.add_parser("plan", help="Plans for remove/reorder.").add_subparsers(dest="action", required=True)
    p = command(pn, "remove", _plan_remove, "Create a removal plan (does not modify Spotify).")
    p.add_argument("playlist", help="Playlist ID, URI, or URL.")
    p.add_argument("--positions", required=True, help='0-based positions, e.g. "3,17,20-22".')
    p.add_argument("--reason")
    p = command(pn, "reorder", _plan_reorder, "Create a reorder plan (does not modify Spotify).")
    p.add_argument("playlist", help="Playlist ID, URI, or URL.")
    order = p.add_mutually_exclusive_group(required=True)
    order.add_argument("--order", help="Comma-separated permutation of current 0-based positions.")
    order.add_argument("--order-file", help='JSON array of positions, or {"new_order": [...]}.')
    order.add_argument("--move", help="FROM:TO, 0-based; moves a single item.")
    order.add_argument(
        "--sort-by",
        choices=plans.REORDER_SORT_KEYS,
        help="Sort by title, artist (first), album, released (edition date), duration, or recorded "
        "(the local recording store). Case, accents, leading punctuation, and a leading 'The' are ignored; "
        "ties keep their current order.",
    )
    order.add_argument(
        "--by-recording-date",
        action="store_true",
        help="Same as --sort-by recorded.",
    )
    p.add_argument("--descending", action="store_true", help="With --sort-by: Z to A, newest or longest first.")
    p.add_argument("--reason")
    p = command(
        pn, "details", _plan_details, "Plan a rename and/or description change (does not modify Spotify)."
    )
    p.add_argument("playlist", help="Playlist ID, URI, or URL.")
    p.add_argument("--name", help="New playlist name.")
    text = p.add_mutually_exclusive_group()
    text.add_argument("--description", help="New description. It can't be empty: Spotify can't clear one through the API.")
    text.add_argument("--description-file", help="Read the new description from a UTF-8 text file.")
    p.add_argument("--reason")
    p = command(pn, "show", _plan_show, "Show and validate a plan.")
    p.add_argument("plan", help="Plan file path or plan_id.")
    p.add_argument("--check", action="store_true", help="Also check it still applies to the live playlist.")
    p = command(pn, "apply", _plan_apply, "Apply a plan after verifying the playlist has not changed.")
    p.add_argument("plan", help="Plan file path or plan_id.")

    return parser


_NO_DATA_GROUPS = ("auth", "data")  # they report or fix the data dir's state, so they never stop on it


def main(argv: list[str] | None = None) -> int:
    global _started
    _started = time.perf_counter()
    metrics.reset()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    argv = sys.argv[1:] if argv is None else argv
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except _UsageError as exc:
        _emit(
            {
                "schema_version": OUTPUT_SCHEMA_VERSION,
                "ok": False,
                "command": " ".join(a for a in argv[:2] if not a.startswith("-")),
                "error": {"code": "USAGE_ERROR", "message": str(exc), "details": {}},
            }
        )
        return 2

    command_name = f"{args.group} {args.action}"
    try:
        settings = load_settings()
        # Commands that use the data dir first make sure data left in a checkout isn't silently ignored.
        data_warnings = [] if args.group in _NO_DATA_GROUPS else datadir.check(settings)
        data = args.handler(args, settings)
        warnings = data_warnings + (data.pop("warnings", []) if isinstance(data, dict) else [])
        _emit(
            {
                "schema_version": OUTPUT_SCHEMA_VERSION,
                "ok": True,
                "command": command_name,
                "data": data,
                "warnings": warnings,
            }
        )
        return 0
    except CuratuneError as exc:
        _emit({"schema_version": OUTPUT_SCHEMA_VERSION, "ok": False, "command": command_name, "error": exc.to_dict()})
        return 1
    except KeyboardInterrupt:
        _emit(
            {
                "schema_version": OUTPUT_SCHEMA_VERSION,
                "ok": False,
                "command": command_name,
                "error": {"code": "INTERRUPTED", "message": "Interrupted.", "details": {}},
            }
        )
        return 130
    except Exception as exc:  # noqa: BLE001 - last-resort envelope so output stays parseable
        _emit(
            {
                "schema_version": OUTPUT_SCHEMA_VERSION,
                "ok": False,
                "command": command_name,
                "error": {"code": "INTERNAL_ERROR", "message": f"{type(exc).__name__}: {exc}"[:500], "details": {}},
            }
        )
        return 3


if __name__ == "__main__":
    sys.exit(main())
