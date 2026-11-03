"""Confirmation of plans: the route a confirmation takes, the summary the user confirms, and the one-time
codes of the confirmation page.

`plan_apply` changes Spotify only after a person answers on a surface the model cannot write to:
- **elicitation**: the client shows a dialog with a summary built here, from the plan file alone, and the
  person accepts or declines. The answer is filled by resolvers, never by tool arguments.
- **page**: for clients without dialogs, curatune opens a local page (`approval_page.py`) with the plan.
  Approve reveals a one-time code that only the person can read and paste in the chat; the model then
  passes it back as `confirmation_code`. The code is bound to one plan and its checksum, expires, allows
  three attempts, and works once, so the model can neither produce nor reuse one.

Routes (`CURATUNE_MCP_CONFIRM`):
- `auto` (default): elicitation when the client declares form elicitation, otherwise the page.
- `elicitation`: elicitation only; without it, no route, and `plan_apply` fails closed
  (CONFIRMATION_UNAVAILABLE).
- `browser`: the page, even for clients that declare elicitation (some declare it and drop the request).

The summary is derived only from the plan file, never from live reads or timestamps: under multi
round-trip requests the SDK matches a recorded answer to the exact question, so the question must be the
same on every round. The plan's `reason`, written by the model, follows the summary in a block of its own,
labelled as the assistant's unverified explanation: the person sees the model's judgment calls where they
decide, never mistaken for what the server checked.

Pure standard library: these modules and their tests run without the `mcp` extra.
"""

from __future__ import annotations

import hmac
import os
import re
import secrets
import threading
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal

from ..errors import ConfigError, CuratuneError
from .numbering import to_number

CONFIRM_MODES = ("auto", "elicitation", "browser")
MAX_LINES = 25
PAGE_MAX_LINES = 500
NAME_CHARS = 80
TEXT_CHARS = 300
REASON_CHARS = 300
REASON_LABEL = "The assistant's explanation (written by the AI, not checked by curatune):"

Route = Literal["elicitation", "page", "code", "unavailable"]


@dataclass(frozen=True)
class Prepared:
    """Everything `plan_apply` decides before asking: the plan, the route, and the question."""

    plan_id: str
    route: Route
    path: Path | None = None
    plan: dict[str, Any] | None = None
    summary: str = ""
    code: str | None = None
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


def choose_route(mode: str, capabilities: Any) -> tuple[Literal["elicitation", "page", "unavailable"], str]:
    """The route and, when there is none, why (for the model and the user)."""
    if mode == "browser":
        return "page", ""
    if declares_form_elicitation(capabilities):
        return "elicitation", ""
    if mode == "elicitation":
        return "unavailable", "this client can't show a confirmation dialog (MCP form elicitation)"
    return "page", ""


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


def _capped(lines: list[str], limit: int) -> list[str]:
    if len(lines) <= limit:
        return lines
    return lines[: limit - 1] + [f"… and {len(lines) - (limit - 1)} more"]


@dataclass(frozen=True)
class Summary:
    """The parts of the question, as plain text (cleaned, not yet escaped for HTML)."""

    head: str
    lines: list[str]
    notes: list[str]
    reason: str
    plan_id: str


def summarize(plan: dict[str, Any], max_lines: int = MAX_LINES) -> Summary:
    """What a plan does, from the (already validated) plan file only."""
    playlist = f'"{clean(plan["playlist"].get("name"))}"'
    kind = plan["kind"]
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
    notes = []
    codes = {w.get("code") for w in plan.get("warnings") or []}
    if "REINSERTED_DUPLICATES" in codes:
        notes.append("Note: kept copies of a repeated track are removed and added back; their date added resets.")
    if "LOCAL_FILE_REMOVAL" in codes:
        notes.append("Note: this removes local files, which is unverified through the API.")
    if "DUPLICATE_NAME" in codes:
        notes.append("Note: you already have another playlist with this name.")
    return Summary(head, _capped(lines, max_lines), notes, clean(plan.get("reason"), REASON_CHARS), plan["plan_id"])


def render_summary(plan: dict[str, Any]) -> str:
    """The question of the elicitation dialog."""
    s = summarize(plan)
    explanation = ["", REASON_LABEL, f'"{s.reason}"', ""] if s.reason else []
    footer = f"Plan {s.plan_id}. Nothing changes unless you accept with “Apply this plan” checked."
    return "\n".join([s.head, *s.lines, *s.notes, *explanation, footer])


# --- One-time codes for the confirmation page ------------------------------------------------------

CONFIRMATION_TTL_SECONDS = 600.0
MAX_CODE_ATTEMPTS = 3
CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32: no I, L, O, U
_CODE_ALIASES = str.maketrans({"O": "0", "I": "1", "L": "1"})

State = Literal["pending", "approved", "rejected", "used", "void"]


class ConfirmationError(CuratuneError):
    """A confirmation code that can't be used. Details never carry the code or the page token."""


def new_code() -> str:
    """8 Crockford base32 characters (40 bits), shown as XXXX-XXXX."""
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"


def normalize_code(text: str) -> str:
    """What the person typed, compared ignoring case, spaces, and hyphens (and O/I/L read as 0/1/1)."""
    return re.sub(r"[\s\-]", "", str(text)).upper().translate(_CODE_ALIASES)


@dataclass
class Confirmation:
    plan_id: str
    checksum: str
    plan: dict[str, Any]
    created: float
    token: str = field(default_factory=lambda: secrets.token_urlsafe(32))  # the page's URL path
    form_nonce: str = field(default_factory=lambda: secrets.token_urlsafe(16))  # its Approve/Reject forms
    state: State = "pending"
    code: str | None = None
    attempts: int = 0


class ConfirmationStore:
    """Pending confirmations, in memory only: a server restart drops them, and the person approves again."""

    def __init__(self, clock: Callable[[], float] = time.monotonic, ttl: float = CONFIRMATION_TTL_SECONDS):
        self._clock = clock
        self._ttl = ttl
        self._lock = threading.Lock()
        self._by_token: dict[str, Confirmation] = {}
        self._latest: dict[str, str] = {}  # plan_id -> token of its most recent confirmation

    def _expired(self, c: Confirmation) -> bool:
        return self._clock() - c.created >= self._ttl

    def _live(self, c: Confirmation) -> bool:
        return c.state in ("pending", "approved") and not self._expired(c)

    def start(self, plan_id: str, checksum: str, plan: dict[str, Any]) -> Confirmation:
        """The confirmation to show for a plan: its current one while it is pending, approved, or (so the
        model can't keep reopening the page) rejected, until it expires; otherwise a new one."""
        with self._lock:
            current = self._by_token.get(self._latest.get(plan_id, ""))
            if (
                current is not None
                and current.checksum == checksum
                and current.state in ("pending", "approved", "rejected")
                and not self._expired(current)
            ):
                return current
            c = Confirmation(plan_id, checksum, plan, created=self._clock())
            self._by_token[c.token] = c
            self._latest[plan_id] = c.token
            return c

    def page_view(self, token: str) -> tuple[Confirmation, str] | None:
        """The confirmation behind a page URL and the state to show (`expired` included)."""
        with self._lock:
            c = self._by_token.get(token)
            if c is None:
                return None
            shown = "expired" if c.state in ("pending", "approved") and self._expired(c) else c.state
            return c, shown

    def _by_form(self, token: str, nonce: str) -> Confirmation | None:
        c = self._by_token.get(token)
        if c is None or not hmac.compare_digest(c.form_nonce.encode(), str(nonce).encode()):
            return None
        return c

    def approve(self, token: str, nonce: str) -> Confirmation | None:
        """Approve from the page. Idempotent: approving again shows the same code."""
        with self._lock:
            c = self._by_form(token, nonce)
            if c is None or not self._live(c):
                return None
            if c.code is None:
                c.code = new_code()
            c.state = "approved"
            return c

    def reject(self, token: str, nonce: str) -> Confirmation | None:
        with self._lock:
            c = self._by_form(token, nonce)
            if c is None or not (self._live(c) or c.state == "rejected"):
                return None
            c.state, c.code = "rejected", None
            return c

    def redeem(self, plan_id: str, checksum: str, code: str) -> Literal["ok", "rejected"]:
        """Check the code the model passes for a plan. "ok" consumes the confirmation (before the plan is
        applied: a failed apply needs a new approval). Every wrong code uses an attempt, also before the
        person approved; the third voids the confirmation."""
        with self._lock:
            c = self._by_token.get(self._latest.get(plan_id, ""))
            if c is None or c.checksum != checksum:
                raise ConfirmationError(
                    "No confirmation page is open for this plan (or the server restarted since).",
                    code="CONFIRMATION_NOT_FOUND",
                    details={"plan_id": plan_id},
                )
            if c.state == "rejected":
                return "rejected"
            if c.state in ("used", "void"):
                raise ConfirmationError(
                    "This confirmation can't be used any more: its code was already used, or too many wrong "
                    "codes were tried.",
                    code="CONFIRMATION_VOID",
                    details={"plan_id": plan_id},
                )
            if self._expired(c):
                c.state = "void"
                raise ConfirmationError(
                    "This confirmation expired (codes last 10 minutes from when the page opened).",
                    code="CONFIRMATION_EXPIRED",
                    details={"plan_id": plan_id},
                )
            expected = normalize_code(c.code) if c.code else ""
            if c.state == "approved" and hmac.compare_digest(expected.encode(), normalize_code(code).encode()):
                c.state = "used"
                return "ok"
            c.attempts += 1
            if c.attempts >= MAX_CODE_ATTEMPTS:
                c.state, c.code = "void", None
                raise ConfirmationError(
                    "Too many wrong codes: this confirmation is void. Nothing changed.",
                    code="CONFIRMATION_VOID",
                    details={"plan_id": plan_id},
                )
            raise ConfirmationError(
                "That code doesn't match this plan's confirmation. Nothing changed.",
                code="CONFIRMATION_CODE_INVALID",
                details={"plan_id": plan_id, "attempts_left": MAX_CODE_ATTEMPTS - c.attempts},
            )
