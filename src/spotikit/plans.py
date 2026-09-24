"""Plans for destructive or order-changing operations (remove, reorder).

Building a plan never touches Spotify beyond reading the playlist. A plan records the
playlist's snapshot_id, the items before, the items after, and the exact low-level operations
that turn one into the other. `apply_plan` refuses to run unless the live playlist still has
the same snapshot_id and the same item URIs, then executes the operations, verifies the
result, and records the outcome in the plan file.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import _writes
from .errors import ApplyFailed, PlanError, SnapshotMismatch, SpotikitError, VerificationFailed
from .http import SpotifyClient
from .models import compact_item
from .playlists import MAX_URIS_PER_REQUEST, chunks, get_playlist, require_editable
from .recordings import RecordingStore, chronological_order

PLAN_SCHEMA_VERSION = 1
PLAN_KINDS = ("remove", "reorder")
MAX_RANGE_LENGTH = 100


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


# --- Pure helpers (no I/O) --------------------------------------------------------------------


def parse_positions(spec: str) -> list[int]:
    """Parse "3,17,20-22" into [3, 17, 20, 21, 22]."""
    positions: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            if "-" in part:
                start, end = (int(x) for x in part.split("-", 1))
                if end < start:
                    raise ValueError
                positions.extend(range(start, end + 1))
            else:
                positions.append(int(part))
        except ValueError:
            raise PlanError("Invalid positions spec.", details={"spec": spec, "part": part}) from None
    return positions


def order_from_move(count: int, from_position: int, to_position: int) -> list[int]:
    """New order (as original positions) after moving one item to `to_position`."""
    if not (0 <= from_position < count and 0 <= to_position < count):
        raise PlanError(
            "Move positions out of range.",
            details={"from": from_position, "to": to_position, "item_count": count},
        )
    order = list(range(count))
    order.insert(to_position, order.pop(from_position))
    return order


def compute_moves(new_order: list[int]) -> list[dict[str, Any]]:
    """Range moves that turn [0..n-1] into `new_order`.

    Walks target positions left to right; when the wrong item is in place, moves the longest
    contiguous block that already has the target sequence up to that position. Blocks only move
    upward, so `insert_before` is simply the target position.
    """
    n = len(new_order)
    current = list(range(n))
    ops: list[dict[str, Any]] = []
    i = 0
    while i < n:
        if current[i] == new_order[i]:
            i += 1
            continue
        j = current.index(new_order[i], i)
        length = 1
        while (
            i + length < n
            and j + length < n
            and length < MAX_RANGE_LENGTH
            and current[j + length] == new_order[i + length]
        ):
            length += 1
        ops.append({"op": "move", "range_start": j, "insert_before": i, "range_length": length})
        block = current[j : j + length]
        del current[j : j + length]
        current[i:i] = block
        i += length
    return ops


def compute_remove_operations(before_uris: list[str], positions: set[int]) -> list[dict[str, Any]]:
    """Operations that remove exactly the items at `positions`.

    The API removes every occurrence of a URI, so occurrences of the same URI that must stay
    are re-inserted at their final positions afterwards.
    """
    targets: list[str] = []
    for p in sorted(positions):
        if before_uris[p] not in targets:
            targets.append(before_uris[p])
    ops: list[dict[str, Any]] = [{"op": "delete_uris", "uris": chunk} for chunk in chunks(targets, MAX_URIS_PER_REQUEST)]

    affected = set(targets)
    after = [uri for idx, uri in enumerate(before_uris) if idx not in positions]
    for new_pos, uri in enumerate(after):
        if uri not in affected:
            continue
        last = ops[-1]
        if last["op"] == "insert" and last["position"] + len(last["uris"]) == new_pos and len(last["uris"]) < MAX_URIS_PER_REQUEST:
            last["uris"].append(uri)
        else:
            ops.append({"op": "insert", "uris": [uri], "position": new_pos})
    return ops


def simulate(items: list[Any], operations: list[dict[str, Any]]) -> list[Any]:
    """Apply operations locally with Spotify's semantics. `delete_uris` matches by value."""
    current = list(items)
    for op in operations:
        kind = op.get("op")
        if kind == "delete_uris":
            doomed = set(op["uris"])
            current = [x for x in current if x not in doomed]
        elif kind == "insert":
            pos = op["position"]
            if not 0 <= pos <= len(current):
                raise PlanError("Insert position out of range.", details={"operation": op})
            current[pos:pos] = op["uris"]
        elif kind == "move":
            start, before, length = op["range_start"], op["insert_before"], op["range_length"]
            if not (0 <= start and length >= 1 and start + length <= len(current) and 0 <= before <= len(current)):
                raise PlanError("Move out of range.", details={"operation": op})
            block = current[start : start + length]
            rest = current[:start] + current[start + length :]
            dest = before if before <= start else before - length
            current = rest[:dest] + block + rest[dest:]
        else:
            raise PlanError("Unknown operation.", details={"operation": op})
    return current


def plan_checksum(plan: dict[str, Any]) -> str:
    core = {
        "schema_version": plan["schema_version"],
        "kind": plan["kind"],
        "playlist_id": plan["playlist"]["id"],
        "snapshot_id": plan["playlist"]["snapshot_id"],
        "before": [i["uri"] for i in plan["before"]],
        "after": [i["uri"] for i in plan["after"]],
        "operations": plan["operations"],
    }
    canonical = json.dumps(core, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def validate_plan(plan: dict[str, Any]) -> None:
    required = ("schema_version", "plan_id", "kind", "playlist", "before", "after", "operations", "checksum")
    missing = [k for k in required if k not in plan]
    if missing:
        raise PlanError("Plan is missing required fields.", details={"missing": missing})
    if plan["schema_version"] != PLAN_SCHEMA_VERSION:
        raise PlanError("Unsupported plan schema version.", details={"schema_version": plan["schema_version"]})
    if plan["kind"] not in PLAN_KINDS:
        raise PlanError("Unknown plan kind.", details={"kind": plan["kind"]})
    if plan_checksum(plan) != plan["checksum"]:
        raise PlanError(
            "Plan checksum mismatch: the plan was modified after it was generated. Regenerate it.",
            code="PLAN_CHECKSUM_MISMATCH",
        )
    before_uris = [i["uri"] for i in plan["before"]]
    if simulate(before_uris, plan["operations"]) != [i["uri"] for i in plan["after"]]:
        raise PlanError("Plan operations do not produce the declared resulting state.", code="PLAN_INCONSISTENT")
    _check_descriptions(plan)


def _check_descriptions(plan: dict[str, Any]) -> None:
    """The human-readable parts of a plan (`after` positions, `changes`) must match what it does.

    The checksum only detects accidental edits, and `simulate` ties `operations` to the `after` URIs.
    This ties `after` to `before` and `changes` to both, so a plan cannot show one change and apply
    another.
    """
    before, after, changes = plan["before"], plan["after"], plan.get("changes") or {}

    def inconsistent(reason: str) -> PlanError:
        return PlanError(f"Plan description is inconsistent: {reason}.", code="PLAN_INCONSISTENT")

    if [b.get("position") for b in before] != list(range(len(before))):
        raise inconsistent("before positions are not 0..n-1")
    for i, a in enumerate(after):
        src = a.get("from_position")
        if a.get("position") != i or not isinstance(src, int) or not 0 <= src < len(before):
            raise inconsistent(f"after[{i}] has invalid positions")
        if a.get("uri") != before[src]["uri"]:
            raise inconsistent(f"after[{i}] does not match before[{src}]")
    sources = [a["from_position"] for a in after]

    if plan["kind"] == "remove":
        kept = set(sources)
        if len(kept) != len(sources) or sources != sorted(sources):
            raise inconsistent("a removal cannot reorder or duplicate items")
        removed = changes.get("remove") or []
        described = [(r.get("position"), r.get("uri")) for r in removed]
        actual = [(p, before[p]["uri"]) for p in range(len(before)) if p not in kept]
        if described != actual:
            raise inconsistent("the listed removals differ from what the plan removes")
    else:
        if sorted(sources) != list(range(len(before))):
            raise inconsistent("a reorder must keep every item exactly once")
        if changes.get("new_order") != sources:
            raise inconsistent("new_order differs from the resulting order")
        moves = [{k: v for k, v in m.items() if k != "items"} for m in changes.get("moves") or []]
        if moves != plan["operations"]:
            raise inconsistent("the listed moves differ from the operations")


# --- Plan files -------------------------------------------------------------------------------


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def resolve_plan_path(ref: str, plans_dir: Path) -> Path:
    """Accept a path to a plan file or a bare plan_id."""
    candidate = Path(ref)
    if candidate.suffix == ".json" and candidate.exists():
        return candidate
    by_id = plans_dir / f"{ref}.json"
    if by_id.exists():
        return by_id
    raise PlanError("Plan not found.", code="PLAN_NOT_FOUND", details={"ref": ref, "plans_dir": str(plans_dir)})


def load_plan(path: Path) -> dict[str, Any]:
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PlanError("Cannot read plan file.", details={"path": str(path), "error": str(exc)}) from None
    validate_plan(plan)
    return plan


def _finalize(
    kind: str,
    state: dict[str, Any],
    changes: dict[str, Any],
    after_positions: list[int],
    operations: list[dict[str, Any]],
    reason: str | None,
    warnings: list[dict[str, Any]],
    plans_dir: Path,
) -> dict[str, Any]:
    playlist = state["playlist"]
    warnings = state.get("warnings", []) + warnings  # read-time warnings (e.g. SNAPSHOT_READ_LAG) first
    before = [compact_item(item) for item in state["items"]]
    after = [{**before[orig], "position": new_pos, "from_position": orig} for new_pos, orig in enumerate(after_positions)]

    # Self-check: the operations must reproduce the declared resulting state.
    if simulate([b["uri"] for b in before], operations) != [a["uri"] for a in after]:
        raise PlanError("Internal error: computed operations do not reproduce the target state.", code="PLAN_INCONSISTENT")

    now = _utc_now()
    plan_id = f"{now:%Y%m%dT%H%M%SZ}-{kind}-{playlist['id'][:8]}-{secrets.token_hex(2)}"
    plan: dict[str, Any] = {
        "schema_version": PLAN_SCHEMA_VERSION,
        "plan_id": plan_id,
        "kind": kind,
        "created_at": _iso(now),
        "reason": reason,
        "playlist": {
            "id": playlist["id"],
            "uri": playlist["uri"],
            "name": playlist["name"],
            "snapshot_id": playlist["snapshot_id"],
            "item_count": len(before),
        },
        "before": before,
        "changes": changes,
        "after": after,
        "operations": operations,
        "warnings": warnings,
    }
    plan["checksum"] = plan_checksum(plan)
    path = plans_dir / f"{plan_id}.json"
    _write_json(path, plan)
    return {
        "plan_path": str(path),
        "plan_id": plan_id,
        "kind": kind,
        "playlist": plan["playlist"],
        "summary": {"items_before": len(before), "items_after": len(after), "operations": len(operations)},
        "changes": changes,
        "warnings": warnings,
    }


# --- Building plans ---------------------------------------------------------------------------


def build_remove_plan(
    client: SpotifyClient,
    playlist_ref: str,
    positions: list[int],
    plans_dir: Path,
    reason: str | None = None,
) -> dict[str, Any]:
    state = get_playlist(client, playlist_ref)  # no market: plans need the stored URIs
    require_editable(state["playlist"])
    items = state["items"]
    count = len(items)

    if not positions:
        raise PlanError("No positions given.")
    if len(set(positions)) != len(positions):
        raise PlanError("Duplicate positions.", details={"positions": positions})
    out_of_range = [p for p in positions if not 0 <= p < count]
    if out_of_range:
        raise PlanError("Positions out of range.", details={"positions": out_of_range, "item_count": count})
    no_uri = [p for p in positions if items[p]["uri"] is None]
    if no_uri:
        raise PlanError("Cannot remove items without a URI (unavailable items).", details={"positions": no_uri})

    to_remove = set(positions)
    before_uris = [i["uri"] for i in items]
    operations = compute_remove_operations(before_uris, to_remove)
    after_positions = [p for p in range(count) if p not in to_remove]

    warnings = []
    reinserted = [op for op in operations if op["op"] == "insert"]
    if reinserted:
        warnings.append(
            {
                "code": "REINSERTED_DUPLICATES",
                "message": "Kept occurrences of duplicated URIs are removed and re-inserted; their added_at resets.",
                "count": sum(len(op["uris"]) for op in reinserted),
            }
        )
    if any(items[p]["is_local"] for p in positions):
        warnings.append({"code": "LOCAL_FILE_REMOVAL", "message": "Removing local files through the API is unverified."})

    changes = {"remove": [compact_item(items[p]) for p in sorted(positions)]}
    return _finalize("remove", state, changes, after_positions, operations, reason, warnings, plans_dir)


def build_reorder_plan(
    client: SpotifyClient,
    playlist_ref: str,
    plans_dir: Path,
    new_order: list[int] | None = None,
    move: tuple[int, int] | None = None,
    recordings: RecordingStore | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    """Exactly one of `new_order`, `move`, or `recordings` (order by recording date) must be given."""
    state = get_playlist(client, playlist_ref)  # no market: plans need the stored URIs
    require_editable(state["playlist"])
    count = len(state["items"])

    if sum(x is not None for x in (new_order, move, recordings)) != 1:
        raise PlanError("Provide exactly one of new_order, move, or recordings.")
    if move is not None:
        new_order = order_from_move(count, *move)
    if recordings is not None:
        new_order = chronological_order(state["items"], recordings.load())
    assert new_order is not None
    if sorted(new_order) != list(range(count)):
        raise PlanError(
            "new_order must be a permutation of all current positions (0-based).",
            details={"item_count": count, "given_length": len(new_order)},
        )
    if new_order == list(range(count)):
        raise PlanError("The new order is identical to the current one.", code="NO_CHANGES")

    operations = compute_moves(new_order)

    # Annotate each move with the items it carries (by original position) for human review.
    compact = [compact_item(item) for item in state["items"]]
    tokens = list(range(count))
    moves = []
    for op in operations:
        block = tokens[op["range_start"] : op["range_start"] + op["range_length"]]
        moves.append(
            {
                **op,
                "items": [{"from_position": t, "name": compact[t]["name"], "artists": compact[t]["artists"]} for t in block],
            }
        )
        tokens = simulate(tokens, [op])

    changes = {"new_order": new_order, "moves": moves}
    return _finalize("reorder", state, changes, new_order, operations, reason, [], plans_dir)


# --- Showing and applying ---------------------------------------------------------------------


def show_plan(path: Path, client: SpotifyClient | None = None) -> dict[str, Any]:
    plan = load_plan(path)
    result: dict[str, Any] = {"plan_path": str(path), "valid": True, "applied": plan.get("applied"), "plan": plan}
    if client is not None:
        state = get_playlist(client, plan["playlist"]["id"])
        same_snapshot = state["playlist"]["snapshot_id"] == plan["playlist"]["snapshot_id"]
        same_items = [i["uri"] for i in state["items"]] == [i["uri"] for i in plan["before"]]
        result["check"] = {
            "applicable": same_snapshot and same_items and not plan.get("applied"),
            "same_snapshot": same_snapshot,
            "same_items": same_items,
            "current_snapshot_id": state["playlist"]["snapshot_id"],
        }
    return result


def _execute(client: SpotifyClient, playlist_id: str, op: dict[str, Any], snapshot_id: str) -> str:
    kind = op["op"]
    if kind == "delete_uris":
        return _writes.remove_uris(client, playlist_id, op["uris"], snapshot_id)
    if kind == "insert":
        return _writes.insert_uris(client, playlist_id, op["uris"], op["position"])
    if kind == "move":
        return _writes.move_range(
            client, playlist_id, op["range_start"], op["insert_before"], op["range_length"], snapshot_id
        )
    raise PlanError("Unknown operation.", details={"operation": op})


def apply_plan(client: SpotifyClient, path: Path, backups_dir: Path) -> dict[str, Any]:
    plan = load_plan(path)
    if plan.get("applied"):
        raise PlanError("This plan was already applied.", code="PLAN_ALREADY_APPLIED", details={"applied": plan["applied"]})

    playlist_id = plan["playlist"]["id"]
    state = get_playlist(client, playlist_id)
    current_uris = [i["uri"] for i in state["items"]]
    expected_uris = [i["uri"] for i in plan["before"]]
    # The URI list must always match. The snapshot (already corrected by get_playlist for read lag
    # after our own writes) must match too.
    if state["playlist"]["snapshot_id"] != plan["playlist"]["snapshot_id"] or current_uris != expected_uris:
        raise SnapshotMismatch(
            "The playlist changed since the plan was generated. Nothing was modified; regenerate the plan.",
            details={
                "plan_snapshot_id": plan["playlist"]["snapshot_id"],
                "current_snapshot_id": state["playlist"]["snapshot_id"],
                "items_changed": current_uris != expected_uris,
            },
        )
    require_editable(state["playlist"])

    now = _utc_now()
    backup_path = backups_dir / f"{playlist_id}-{now:%Y%m%dT%H%M%SZ}-before-{plan['plan_id']}.json"
    _write_json(
        backup_path,
        {"created_at": _iso(now), "plan_id": plan["plan_id"], "playlist": state["playlist"], "items": state["items"]},
    )

    snapshot_id = plan["playlist"]["snapshot_id"]
    done = 0
    for op in plan["operations"]:
        try:
            snapshot_id = _execute(client, playlist_id, op, snapshot_id)
        except SpotikitError as exc:
            if client.write_log is not None:
                client.write_log.forget(playlist_id)  # state is unknown now; do not vouch for it
            raise ApplyFailed(
                "Applying the plan failed partway; the playlist may be partially modified.",
                details={
                    "operations_done": done,
                    "operations_total": len(plan["operations"]),
                    "failed_operation": op,
                    "error": exc.to_dict(),
                    "backup_path": str(backup_path),
                },
            ) from None
        done += 1

    expected_after = [i["uri"] for i in plan["after"]]
    if client.write_log is not None:
        client.write_log.record(playlist_id, snapshot_id, expected_after)
    final = get_playlist(client, playlist_id)
    final_uris = [i["uri"] for i in final["items"]]
    verified = final_uris == expected_after
    result = {
        "applied": True,
        "plan_id": plan["plan_id"],
        "playlist_id": playlist_id,
        "operations_done": done,
        # The last write's snapshot is authoritative; reads may still return an older one.
        "snapshot_id": snapshot_id,
        "verified": verified,
        "backup_path": str(backup_path),
    }
    plan["applied"] = {"applied_at": _iso(_utc_now()), **{k: result[k] for k in ("snapshot_id", "verified", "backup_path")}}
    _write_json(path, plan)

    if not verified:
        raise VerificationFailed(
            "The plan was applied but the resulting playlist does not match the expected state.",
            details={**result, "expected_uris": expected_after, "actual_uris": final_uris},
        )
    return result
