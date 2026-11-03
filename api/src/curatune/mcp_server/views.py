"""What the model sees: compact views of the library's results.

Views only pick and rename fields. Every position becomes a 1-based number through the numbering
module (`numbered()`, `to_number()`), the one conversion point; nothing here adds or subtracts one.
"""

from __future__ import annotations

from typing import Any

from ..models import brief_track
from .numbering import numbered, to_number


def playlist_summary(p: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "name", "owner_name", "owned", "collaborative", "public", "item_count", "url")
    return {k: p.get(k) for k in keys}


def playlist_info(p: dict[str, Any]) -> dict[str, Any]:
    return {**playlist_summary(p), "description": p.get("description")}


def playlists_list(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "count": data["count"],
        "playlists": [playlist_summary(p) for p in data["playlists"]],
        "warnings": numbered(data["warnings"]),
    }


def track(t: dict[str, Any], full: bool) -> dict[str, Any]:
    return numbered(t if full else brief_track(t))


def playlist_page(data: dict[str, Any], start_position: int, limit: int, full: bool) -> dict[str, Any]:
    items = data["items"]
    page = items[start_position : start_position + limit]
    end = start_position + len(page)
    return {
        "playlist": playlist_info(data["playlist"]),
        "items": [track(i, full) for i in page],
        "total": len(items),
        "start": to_number(start_position),
        "next_start": to_number(end) if end < len(items) else None,
        "warnings": numbered(data["warnings"]),
    }


def search(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "query": data["query"],
        "total": data["total"],
        "offset": data["offset"],
        "limit": data["limit"],
        "next_offset": data["next_offset"],
        "results": [brief_track(t) for t in data["results"]],
        "warnings": data["warnings"],
    }


def search_many(data: dict[str, Any]) -> dict[str, Any]:
    searches = []
    for s in data["searches"]:
        if s["ok"]:
            view = search(s)
            keys = ("query", "total", "next_offset", "results", "warnings")
            searches.append({"id": s["id"], "ok": True, **{k: view[k] for k in keys}})
        else:
            searches.append({"id": s["id"], "ok": False, "error": s["error"]})
    return {"count": data["count"], "failed": data["failed"], "searches": searches}


def album_tracks(data: dict[str, Any], full: bool) -> dict[str, Any]:
    a = data["album"]
    return {
        "album": {
            "id": a.get("id"),
            "uri": a.get("uri"),
            "name": a.get("name"),
            "album_type": a.get("album_type"),
            "release_date": a.get("release_date"),
            "artists": [x.get("name") for x in a.get("artists") or []],
            "total_tracks": a.get("total_tracks"),
            "url": a.get("url"),
        },
        "tracks": [track(t, full) for t in data["tracks"]],
    }


def recordings_show(data: dict[str, Any]) -> dict[str, Any]:
    items = []
    for i in data["items"]:
        rec = i["recording"] or {}
        items.append(
            {
                "position": i["position"],
                "uri": i["uri"],
                "name": i["name"],
                "artists": i["artists"],
                "recorded": rec.get("recorded"),
                "confidence": rec.get("confidence"),
                "source": rec.get("source"),
            }
        )
    return numbered(
        {
            "playlist": {"id": data["playlist"]["id"], "name": data["playlist"]["name"]},
            "items": items,
            "missing": data["missing"],
            "chronological": data["chronological"],
            "warnings": data["warnings"],
        }
    )


def playlist_create(data: dict[str, Any]) -> dict[str, Any]:
    p = data["playlist"]
    return {
        "playlist": {"id": p["id"], "name": p["name"], "url": p["url"], "public": p["public"]},
        "warnings": data["warnings"],
    }


def playlist_add(data: dict[str, Any]) -> dict[str, Any]:
    return numbered(
        {
            "playlist_id": data["playlist_id"],
            "added": data["added"],
            "skipped": data["skipped"],
            "item_count": data["item_count"],
            "verified": data["verified"],
            "warnings": data["warnings"],
        }
    )


# --- Plans --------------------------------------------------------------------------------------------

PLAN_LIST_CAP = 300  # items listed in a plan view; past that, counts only (client result-size limits)


def _plan_track(item: dict[str, Any], *keys: str) -> dict[str, Any]:
    return {k: item.get(k) for k in (*keys, "uri", "name", "artists")}


def plan(p: dict[str, Any], next_step: str) -> dict[str, Any]:
    """A plan as the model sees it: what changes, by number, title, and artists; no raw operations."""
    view: dict[str, Any] = {
        "plan_id": p["plan_id"],
        "kind": p["kind"],
        "playlist": {"id": p["playlist"]["id"], "name": p["playlist"].get("name")},
        "created_at": p.get("created_at"),
        "reason": p.get("reason"),
        "operations": len(p["operations"]),
    }
    if p["kind"] == "remove":
        view["tracks_before"], view["tracks_after"] = len(p["before"]), len(p["after"])
        view["remove"] = [_plan_track(r, "position") for r in p["changes"]["remove"]]
    elif p["kind"] == "reorder":
        after = p["after"]
        view["tracks_before"], view["tracks_after"] = len(p["before"]), len(after)
        view["moved"] = sum(a["position"] != a["from_position"] for a in after)
        view["new_order"] = [_plan_track(a, "position", "from_position") for a in after[:PLAN_LIST_CAP]]
        view["new_order_truncated"] = len(after) > PLAN_LIST_CAP
    else:
        view["changes"] = p["changes"]
    applied = p.get("applied")
    view["applied"] = {k: applied.get(k) for k in ("applied_at", "verified")} if applied else None
    view["warnings"] = p.get("warnings") or []
    view["next_step"] = next_step
    return numbered(view)


def plan_applied(result: dict[str, Any]) -> dict[str, Any]:
    """The outcome of applying a plan, without local paths (backups stay on the user's machine)."""
    view: dict[str, Any] = {
        "status": "applied",
        "plan_id": result["plan_id"],
        "verified": result["verified"],
        "operations_done": result["operations_done"],
        "warnings": numbered(result.get("warnings") or []),
    }
    if "current" in result:  # details plans: the name and description as read back
        view["current"] = result["current"]
    return view
