"""The local confirmation page: a plan rendered from its plan file, with Approve and Reject.

It serves only `127.0.0.1`, on an ephemeral port, from a daemon thread started on the first page-route
`plan_apply`. Each confirmation has its own unguessable URL (`/confirm/<token>`), which curatune opens in
the browser itself and never puts in a tool result, a log, or stderr. Approve reveals the one-time code
that the person pastes in the chat.

Defences:
- every request must carry `Host: 127.0.0.1:<port>` exactly (DNS rebinding);
- Approve and Reject are POSTs that also need a matching `Origin` and the page's form nonce (CSRF);
- the page is static HTML with no JavaScript; every piece of plan text is escaped; the CSP allows only the
  page's own nonce-tagged style and forms posting to itself, and no framing;
- requests are never logged (the default handler would write the token to stderr).

Pure standard library, like `confirm.py`.
"""

from __future__ import annotations

import html
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs

from .confirm import REASON_LABEL, Confirmation, ConfirmationStore, PAGE_MAX_LINES, summarize

MAX_BODY_BYTES = 4096


class ApprovalPage:
    """The page server for one MCP server process, started lazily."""

    def __init__(self, store: ConfirmationStore):
        self.store = store
        self._lock = threading.Lock()
        self._httpd: ThreadingHTTPServer | None = None
        self._port = 0

    @property
    def port(self) -> int:
        self._start()
        return self._port

    def url_for(self, confirmation: Confirmation) -> str:
        """Starts the server if needed. The URL goes to the browser only."""
        return f"http://127.0.0.1:{self.port}/confirm/{confirmation.token}"

    def _start(self) -> None:
        with self._lock:
            if self._httpd is not None:
                return
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), _handler(self))
            httpd.daemon_threads = True
            self._port = httpd.server_address[1]
            threading.Thread(
                target=httpd.serve_forever, kwargs={"poll_interval": 0.1}, name="curatune-approval-page", daemon=True
            ).start()
            self._httpd = httpd

    def close(self) -> None:
        with self._lock:
            if self._httpd is not None:
                self._httpd.shutdown()
                self._httpd.server_close()
                self._httpd = None


def _handler(page: ApprovalPage) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "curatune"
        sys_version = ""

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - the request line holds the token
            pass

        def _origin(self) -> str:
            return f"http://127.0.0.1:{page._port}"

        def _send(self, status: int, body: str, style_nonce: str | None = None) -> None:
            data = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            style = f"style-src 'nonce-{style_nonce}'" if style_nonce else "style-src 'none'"
            self.send_header(
                "Content-Security-Policy",
                f"default-src 'none'; {style}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            )
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            # Not "no-referrer": with it, browsers send `Origin: null` on the form POSTs, which the Origin
            # check refuses (seen in Chromium). The page links nowhere, so nothing leaves the machine.
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _refuse(self, status: int, message: str) -> None:
            self._send(status, f"<!doctype html><title>curatune</title><p>{html.escape(message)}</p>")

        def _host_ok(self) -> bool:
            return self.headers.get("Host") == f"127.0.0.1:{page._port}"

        def _token(self, suffix: str = "") -> str | None:
            parts = self.path.split("?", 1)[0].split("/")
            # /confirm/<token> or /confirm/<token>/<action>
            if len(parts) == 3 + bool(suffix) and parts[1] == "confirm" and (not suffix or parts[3] == suffix):
                return parts[2]
            return None

        def do_GET(self) -> None:  # noqa: N802 - http.server's naming
            if not self._host_ok():
                return self._refuse(403, "Forbidden.")
            token = self._token()
            found = page.store.page_view(token) if token else None
            if found is None:
                return self._refuse(404, "Not found.")
            self._render(*found)

        def do_POST(self) -> None:  # noqa: N802
            if not self._host_ok() or self.headers.get("Origin") != self._origin():
                return self._refuse(403, "Forbidden.")
            action = next((a for a in ("approve", "reject") if self._token(a)), None)
            token = self._token(action) if action else None
            length = int(self.headers.get("Content-Length") or 0)
            if token is None or not 0 < length <= MAX_BODY_BYTES:
                return self._refuse(400, "Bad request.")
            form = parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
            nonce = (form.get("nonce") or [""])[0]
            done = page.store.approve(token, nonce) if action == "approve" else page.store.reject(token, nonce)
            if done is None:
                found = page.store.page_view(token)
                if found is None or not secrets.compare_digest(found[0].form_nonce, nonce):
                    return self._refuse(403, "Forbidden.")
            # Back to the page's own address, which shows the new state (the code, once approved), so a
            # reload neither re-posts nor lands on a dead URL.
            self.send_response(303)
            self.send_header("Location", f"/confirm/{token}")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_PUT(self) -> None:  # noqa: N802
            self._refuse(405, "Method not allowed.")

        do_DELETE = do_PATCH = do_PUT  # noqa: N815

        def _render(self, c: Confirmation, shown: str) -> None:
            nonce = secrets.token_urlsafe(16)
            self._send(200, render(c, shown, nonce), style_nonce=nonce)

    return Handler


# --- HTML ------------------------------------------------------------------------------------------

_E = html.escape

_STYLE = """
:root { --bg: #fafaf7; --fg: #1d1d1b; --muted: #5f5f5a; --line: #deded8; --ok: #1f6f43; --no: #9b2c2c;
        --box: #ffffff; --code-bg: #eef5f0; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #171716; --fg: #ececea; --muted: #a3a39d; --line: #33332f; --ok: #6cc196; --no: #e58b8b;
          --box: #1f1f1d; --code-bg: #1d2a22; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
       font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 2rem 1rem 3rem; }
h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
.sub { color: var(--muted); margin: 0 0 1.5rem; }
.box { background: var(--box); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.25rem; }
ol, ul { padding-left: 1.25rem; margin: .5rem 0 0; }
li { margin: .15rem 0; overflow-wrap: anywhere; }
.note { color: var(--muted); font-size: .95rem; }
.reason { margin-top: 1.25rem; border-left: 3px solid var(--line); padding: .25rem 0 .25rem .9rem; }
.reason p { margin: .25rem 0; overflow-wrap: anywhere; }
.label { color: var(--muted); font-size: .9rem; }
.actions { display: flex; gap: .75rem; margin-top: 1.5rem; flex-wrap: wrap; }
button { font: inherit; padding: .6rem 1.2rem; border-radius: 8px; border: 1px solid var(--line);
         background: var(--box); color: var(--fg); cursor: pointer; }
button.approve { background: var(--ok); border-color: var(--ok); color: #fff; }
.code { font: 600 2.2rem/1.2 ui-monospace, "Cascadia Mono", Consolas, monospace; letter-spacing: .12em;
        background: var(--code-bg); border-radius: 10px; padding: 1rem; text-align: center; margin: 1rem 0; }
.ok { color: var(--ok); } .no { color: var(--no); }
.id { color: var(--muted); font-size: .85rem; margin-top: 1.5rem; overflow-wrap: anywhere; }
"""


def _page(title: str, body: str, nonce: str) -> str:
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f'<title>{_E(title)}</title>'
        f'<style nonce="{_E(nonce)}">{_STYLE}</style></head><body><main>{body}</main></body></html>'
    )


def _plan_block(c: Confirmation) -> str:
    s = summarize(c.plan, max_lines=PAGE_MAX_LINES)
    items = "".join(f"<li>{_E(line)}</li>" for line in s.lines)
    notes = "".join(f'<p class="note">{_E(n)}</p>' for n in s.notes)
    reason = (
        f'<div class="reason"><p class="label">{_E(REASON_LABEL)}</p><p>“{_E(s.reason)}”</p></div>' if s.reason else ""
    )
    return f'<div class="box"><p><strong>{_E(s.head)}</strong></p><ul>{items}</ul>{notes}{reason}</div>'


def render(c: Confirmation, shown: str, nonce: str) -> str:
    """The page for a confirmation in a given state. Built from the plan file; everything is escaped."""
    plan_id = f'<p class="id">Plan {_E(c.plan_id)}</p>'
    if shown == "pending":
        action = f"/confirm/{_E(c.token)}"
        hidden = f'<input type="hidden" name="nonce" value="{_E(c.form_nonce)}">'
        body = (
            "<h1>Confirm a change to your Spotify playlist</h1>"
            '<p class="sub">Your AI assistant asked curatune to apply this plan. Nothing changes unless you '
            "approve it here and paste the code it shows in your chat.</p>"
            f"{_plan_block(c)}"
            '<div class="actions">'
            f'<form method="post" action="{action}/approve">{hidden}<button class="approve">Approve</button></form>'
            f'<form method="post" action="{action}/reject">{hidden}<button>Reject</button></form>'
            f"</div>{plan_id}"
        )
        return _page("curatune: confirm a plan", body, nonce)
    if shown == "approved":
        body = (
            '<h1 class="ok">Approved</h1>'
            '<p class="sub">Paste this code in your chat with the assistant. It applies this plan once, and '
            "only within 10 minutes of when this page opened.</p>"
            f'<p class="code">{_E(c.code or "")}</p>'
            f"{_plan_block(c)}{plan_id}"
        )
        return _page("curatune: approved", body, nonce)
    if shown == "rejected":
        body = (
            '<h1 class="no">Rejected</h1>'
            '<p class="sub">Nothing changes. You can close this tab and tell the assistant.</p>'
            f"{_plan_block(c)}{plan_id}"
        )
        return _page("curatune: rejected", body, nonce)
    messages = {
        "used": "This plan's code was already used. You can close this tab.",
        "void": "This confirmation is void (too many wrong codes). Nothing changed; ask the assistant to open a "
        "new one if you still want this plan.",
        "expired": "This confirmation expired. Nothing changed; ask the assistant to open a new one if you still "
        "want this plan.",
    }
    body = f"<h1>Confirmation closed</h1><p class=\"sub\">{_E(messages.get(shown, 'Nothing to confirm.'))}</p>{plan_id}"
    return _page("curatune", body, nonce)
