"""Confirmation of plans: the route a confirmation takes, and the summary the user confirms.

`plan_apply` changes Spotify only after a person answers on a surface the model cannot write to. In this
version that surface is MCP elicitation: the client shows a dialog with a summary built here, from the
plan file alone, and the person accepts or declines. The model never sees the question as something it
can answer, and a client that sends an answer as a tool argument is ignored (resolved parameters are not
arguments).

Routes (`CURATUNE_MCP_CONFIRM`):
- `auto` (default) and `elicitation`: elicitation when the client declares form elicitation; otherwise
  no route, and `plan_apply` fails closed with CONFIRMATION_UNAVAILABLE.
- `browser`: the local confirmation page (phase 2b of PLAN-mcp.md); not available yet, so it fails closed.

The summary is derived only from the plan file, never from live reads or timestamps: under multi
round-trip requests the SDK matches a recorded answer to the exact question, so the question must be the
same on every round. The plan's `reason`, written by the model, follows the summary in a block of its own,
labelled as the assistant's unverified explanation: the person sees the model's judgment calls where they
decide, never mistaken for what the server checked.
"""

from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from ..errors import ConfigError, CuratuneError
from .numbering import to_number

CONFIRM_MODES = ("auto", "elicitation", "browser")
MAX_LINES = 25
NAME_CHARS = 80
TEXT_CHARS = 300
REASON_CHARS = 300
REASON_LABEL = "The assistant's explanation (written by the AI, not checked by curatune):"


@dataclass(frozen=True)
class Prepared:
    """Everything `plan_apply` decides before asking: the plan, the route, and the question."""

    plan_id: str
    route: Literal["elicitation", "unavailable"]
    path: Path | None = None
    summary: str = ""
    error: CuratuneError | None = None
    unavailable_reason: str = ""


def confirm_mode() -> str:
    mode = (os.environ.get("CURATUNE_MCP_CONFIRM") or "auto").strip().lower()
    if mode not in CONFIRM_MODES:
        raise ConfigError(
            "CURATUNE_MCP_CONFIRM must be auto, elicitation, or browser.", details={"value": mode}
        )
    return mode


def declares_form_elicitation(capabilities: Any) -> bool:
    """Form elicitation is declared as `elicitation: {form: {}}`, or a bare `elicitation: {}` (the shape
    before modes existed). URL-only does not count."""
    elicitation = getattr(capabilities, "elicitation", None) if capabilities is not None else None
    return elicitation is not None and (elicitation.form is not None or elicitation.url is None)


def choose_route(mode: str, capabilities: Any) -> tuple[Literal["elicitation", "unavailable"], str]:
    """The route and, when there is none, why (for the model and the user)."""
    if mode == "browser":
        return "unavailable", "the confirmation page (CURATUNE_MCP_CONFIRM=browser) is not available in this version"
    if declares_form_elicitation(capabilities):
        return "elicitation", ""
    return "unavailable", "this client can't show a confirmation dialog (MCP form elicitation)"


# --- The summary the user confirms -----------------------------------------------------------------

_SPACES = re.compile(r"\s+")


def clean(text: Any, limit: int = NAME_CHARS) -> str:
    """Third-party text made safe to show: no control or format characters (line breaks, bidi
    overrides), single spaces, and a length cap."""
    chars = (" " if unicodedata.category(c).startswith("C") else c for c in str(text or ""))
    flat = _SPACES.sub(" ", "".join(chars)).strip()
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "…"


def _track(item: dict[str, Any]) -> str:
    name = clean(item.get("name")) if item.get("name") else "(unavailable track)"
    artists = clean(", ".join(a for a in item.get("artists") or [] if a))
    return f'"{name}"' + (f" by {artists}" if artists else "")


def _capped(lines: list[str]) -> list[str]:
    if len(lines) <= MAX_LINES:
        return lines
    return lines[: MAX_LINES - 1] + [f"… and {len(lines) - (MAX_LINES - 1)} more"]


def render_summary(plan: dict[str, Any]) -> str:
    """The question shown to the user, from the (already validated) plan file only."""
    playlist = f'"{clean(plan["playlist"].get("name"))}"'
    kind = plan["kind"]
    notes = []
    if kind == "remove":
        removed, total = plan["changes"]["remove"], len(plan["before"])
        head = f"Remove {len(removed)} of {total} tracks from the playlist {playlist} ({total} → {total - len(removed)}):"
        lines = [f"#{to_number(r['position'])} {_track(r)}" for r in removed]
    elif kind == "reorder":
        moved = [a for a in plan["after"] if a["position"] != a["from_position"]]
        head = f"Reorder the playlist {playlist}: {len(moved)} of {len(plan['before'])} tracks change place."
        lines = [f"#{to_number(a['from_position'])} → #{to_number(a['position'])} {_track(a)}" for a in moved]
    else:
        head = f"Change the playlist {playlist}:"
        labels = {"name": "Name", "description": "Description"}
        lines = [
            f'{labels[field]}: "{clean(plan["before"][field], TEXT_CHARS) or "(empty)"}"'
            f' → "{clean(plan["after"][field], TEXT_CHARS) or "(empty)"}"'
            for field in ("name", "description")
            if field in plan["after"]
        ]
    codes = {w.get("code") for w in plan.get("warnings") or []}
    if "REINSERTED_DUPLICATES" in codes:
        notes.append("Note: kept copies of a repeated track are removed and added back; their date added resets.")
    if "LOCAL_FILE_REMOVAL" in codes:
        notes.append("Note: this removes local files, which is unverified through the API.")
    if "DUPLICATE_NAME" in codes:
        notes.append("Note: you already have another playlist with this name.")
    explanation = []
    reason = clean(plan.get("reason"), REASON_CHARS)
    if reason:
        explanation = ["", REASON_LABEL, f'"{reason}"', ""]
    footer = f"Plan {plan['plan_id']}. Nothing changes unless you accept with “Apply this plan” checked."
    return "\n".join([head, *_capped(lines), *notes, *explanation, footer])
