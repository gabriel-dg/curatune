# Design of the MCP server

Why `curatune-mcp` is built the way it is: its goals, the decisions and the alternatives discarded, the
confirmation model and its threat boundary, and the facts about MCP and its clients that the design rests
on, as checked in October 2026 (sources at the end). [mcp.md](mcp.md) describes how to set up and use it.

## Goals

- **Same semantics as the CLI**, with no confirmation rule relaxed.
- **A confirmation the model can't give.** Applying a plan needs a human answer that the model can't
  produce, forge, or skip, in every target client (Claude Code, Claude Desktop, LM Studio), including when
  the model is wrong or manipulated by text written by third parties.
- **The library stays independent.** `import curatune` and the CLI never import the `mcp` package.
- **Tested without real clients** wherever possible: an in-memory MCP client, the fake playlist API, both
  protocol eras, Windows and Linux in CI. Real clients only for what a test can't reach.

Not goals: a remote server (D1), playback, library, listening history, visibility, deleting playlists.

## Facts the design rests on (October 2026)

**The protocol.** The current revision, 2026-07-28 ([versioning], [changelog]), has no `initialize`
handshake and no per-connection state. *Multi round-trip requests* (MRTR) replace server-initiated requests:
an elicitation comes back as an `InputRequiredResult` and is answered on a retry of the same call
([mrtr]). State across calls travels in handles the server mints; a `plan_id` is one. Form elicitation
uses flat, primitive schemas, must not ask for secrets, and lets the person accept, decline, or cancel;
the client shows which server asks ([elicitation]). Tool annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`) are hints, untrusted unless the server is trusted ([tools], [schema]).

**The Python SDK.** `mcp` 2.2.0 (2026-09-07) serves both protocol eras ([pypi-mcp], [sdk-versions]).
*Resolvers* (`Annotated[T, Resolve(fn)]` returning `Elicit(...)`) ask the person on either era; a resolved
parameter is not in the input schema, and a value a client sends for it is ignored ([sdk-elicitation],
[sdk-dependencies]). MRTR state is sealed by default ([sdk-mrtr]). Plain `def` tools run in a worker
thread, and `Client(server)` connects in memory for tests ([sdk-src], [sdk-testing]). Its dependencies are
heavy, one more reason for an optional extra.

**The clients.**

| Client | Dialogs (elicitation) | Other facts |
|---|---|---|
| Claude Code 2.1.286–2.1.287 | **Observed**: declares form and URL elicitation in both eras. | Truncates server instructions at 2048 characters; caps tool results at 25,000 tokens by default; `_meta["anthropic/requiresUserInteraction"]` forces a prompt even in bypass modes; an `Elicitation` hook can answer dialogs automatically ([cc-hooks]). Over stdio it negotiated 2026-07-28 by default, unlike its docs ([cc-mcp], [cc-env]). |
| Claude Desktop | No evidence of support ([claude-building], [claude-notes], [issue-41110]); not tested. | Documents that `readOnlyHint` and `destructiveHint` drive its permission prompts ([claude-review]). Results capped at about 150,000 characters, 240 s timeout. |
| Cowork (in Claude Desktop) | Declares elicitation but drops the request, and the call hangs ([issue-1046]). | Capability detection can't catch this. |
| LM Studio 0.3.17+ | Not documented ([lms-docs]). | A per-call confirmation dialog with editable arguments and "always allow" ([lms-0317]). |

So only Claude Code confirms through dialogs today; elsewhere the confirmation page is the main path.

## Decisions

**D1. Local stdio only.** A remote server would have to hold other people's Spotify refresh tokens (never
passing them through to the client, [security]), run a second OAuth system on top of Spotify's, trade the
local confirmation page for URL elicitation and its phishing risks, and operate as a public service, all
within Development Mode's limit of 5 users per app. *Discarded:* a remote server behind an access proxy for
a single person: all operational cost, no benefit over stdio.

**D2. A thin entry point in the same package, as an optional extra:** `src/curatune/mcp_server/`, the
`curatune-mcp` script, and `mcp>=2.2,<3`. It holds no Spotify logic; a static test keeps it from importing
`_writes` or `requests`. *Discarded:* a separate project (duplicated packaging), one `mcp_server.py` (the
confirmation machinery would bloat it), and `curatune/mcp/` (it reads as shadowing the `mcp` package).

**D3. Confirmation outside the model's reach.** Plans stay the only way to remove, reorder, or rename.
`plan_apply` acts only after a human answers on a surface the model can't write to: the client's dialog if
it declares form elicitation, otherwise a local page that reveals a one-time code. *Discarded:*
- an Approve button with no code: not tied to a chat, and Claude Desktop serves every chat from one process;
- no fallback, applying through the CLI only: Claude Desktop and LM Studio could never apply;
- the client's tool-approval prompt alone: it shows only a `plan_id`, and LM Studio offers "always allow";
- no apply tool, as in the web app: an MCP server has no UI besides dialogs, a page, or an MCP App;
- a native OS dialog: missing on some Python builds, unreliable from background processes on macOS.

An *MCP App* plan viewer for Claude Desktop is on hold until Desktop is tested: its app-only approval tool
would have to be provably invisible to the model.

**D4. Track numbers from 1 at the boundary.** Tools take and return `number` (1 = the first track, as in
the Spotify app); one module, `numbering.py`, converts both ways, and output schemas reject a stray
`position`. The library, plan files, and the CLI stay 0-based. Evidence: in the web app's evaluation a 9B
model read 0-based positions as track numbers. *Discarded:* 0-based for consistency, which every model
would have to convert, and small models convert wrong.

**D5. One data directory, shared with the CLI, outside the repository**, for plans, backups, the write
log, and recording dates. *Discarded:* a directory for MCP only (two write logs would blind the read-lag
compensation to each other's writes, and split the recording dates), and moving existing files on first
run (a silent change to your data).

**D6. Configuration without a checkout.** An installed server has no repository: the project root exists
only in a source checkout, `.env` is read from the checkout and the config directory, and the "token
outside the repository" check runs only with a checkout. *Discarded:* falling back to the working
directory, which is arbitrary for a process a client starts.

**D7. A small tool surface, with safety in code.** Tool names match the web app's, so both can share
evaluation scenarios. No tool takes a visibility option (`playlist_create` always requests private) or a
file path: data goes as JSON arrays, which removes the CLI's `--from-file` exfiltration risk, and
`plan_show` and `plan_apply` take only plan IDs. Write tools are split by effect so their annotations are
accurate: `recordings_set` only adds (`destructiveHint: false`) and `recordings_update` replaces stored
dates (`destructiveHint: true`); one tool with an `overwrite` flag would be destructive on every call. Plan
builders only write a local plan file, so they are marked read-only.

**D8. Output budgets.** Brief results by default: `playlist_show` pages at 100 tracks, `search_many` takes
up to 25 searches (5 results each by default), and plan views list up to 300 items, then a count. Every
tool declares an output schema and returns structured content plus the same JSON as text. Timing goes to
stderr: metrics are per process, and calls run concurrently.

**D9. Concurrency.** One token manager per process, a new Spotify client per call (HTTP clients aren't
shared across threads), and a process-wide lock around create, add, apply, and the recording-date tools.

**D10. The skill's rules move into the server.** What the CLI's skill asks of an agent is enforced in code
where possible: confirmations, no visibility parameter, no paths, the additive recording-date tool. The rest
lives in the server instructions and the tool descriptions (clients that ignore instructions still read
descriptions), and tests check that both carry the rules.

**D11. Considered and not adopted.**
- *Accepting only IDs seen earlier in the conversation*, as the web app does: the server can't see the
  conversation. Instead, `playlist_add` reads the playlist back and names each added track.
- *A live check before asking*: under MRTR the question is rebuilt on every round, which would read the
  playlist each time, and `plan_apply` re-verifies anyway.
- *Caching playlist reads between pages*: the snapshot read lag would serve stale items after a write.

## The confirmation model

`CURATUNE_MCP_CONFIRM` picks the route: `auto` (the default) uses the dialog when the client declares form
elicitation, otherwise the page; `elicitation` requires the dialog; `browser` forces the page.

**The dialog.** The question is built from the plan file alone, never from live reads or timestamps, since
the SDK matches a recorded MRTR answer to the exact question text. It lists what leaves or moves, by
number, title, and artists, or the old and new name and description; third-party text is stripped of
control characters, line breaks, and bidirectional overrides, capped at 80 characters, and quoted, with at
most 25 lines. The model's required `reason` (at most 300 characters) follows apart, labelled as the
assistant's unchecked explanation. Only "accept" with "Apply this plan" checked applies; anything else,
including no answer, changes nothing.

**The page.** `plan_apply(plan_id)` validates the plan, opens a page itself on `127.0.0.1` (an ephemeral
port, a random 32-byte path), and returns `awaiting_user_confirmation`. The page is static HTML with no
JavaScript and a strict CSP; Approve and Reject are POSTs that need the exact `Host`, a matching `Origin`,
and the form nonce. Approve shows a code of 8 Crockford base32 characters (40 bits), bound to the plan ID
and checksum, valid for 10 minutes and three attempts, single use, and used up before applying. The page's
address and the code never appear in a tool result, a log, or stderr. Without a browser, the call fails
closed (`CONFIRMATION_UNAVAILABLE`) and names the CLI commands instead.

## Threats and security properties

**Defended against:** a model that is wrong or manipulated by third-party text (names, descriptions, plan
files from elsewhere), and a model that tries to apply without the person, invents a code, or replays one.

**Guaranteed:** the person confirms a summary the server renders from the checksummed plan file, not the
model's paraphrase; the answer comes through the client's UI or the person's own typing; it is single use
and bound to one plan; and applying re-verifies the live playlist (snapshot and items), backs it up, and
checks the result. A `plan_id` is a name, not a capability ([security]): the confirmation is the
authorization.

**Outside the boundary**, documented and not defended: an agent with shell access acting adversarially
(it could read the token and call Spotify directly), and a client set up to answer dialogs by itself, such
as a Claude Code `Elicitation` hook.

**Defense in depth:** `requiresUserInteraction` on `plan_apply` (Claude Code prompts even in bypass modes),
`destructiveHint` (Claude Desktop always prompts), and the `browser` override for clients that declare
dialogs and drop them. DNS rebinding and CSRF against the page meet the loopback bind, the random path, the
`Host` and `Origin` checks, the nonce, and the CSP; oversized results meet D8's budgets; SDK churn meets a
pin below `mcp` 3 and CI in both protocol eras.

## Found while building

- Claude Code cut the server instructions at 2048 characters; a test keeps them under it.
- With `no-referrer`, Chromium sends `Origin: null` on form POSTs, which the page refused; now `same-origin`.
- On Windows, a socket closed with unread data resets the connection: the page reads refused POSTs first.
- MSIX-packaged apps (Claude Desktop) virtualize AppData for what they start; curatune refuses such folders.
- In live tests a model applied plans without explaining them, so plan tools require a `reason`; and a
  model stored wrong recording dates "from memory", one marked high, so dates need a checkable source.

## Sources (accessed 2026-10-01)

- The MCP specification: [versioning], [changelog], [mrtr], [elicitation], [tools], [schema], [security].
- The MCP Python SDK: [pypi-mcp], [sdk-versions], [sdk-elicitation], [sdk-dependencies], [sdk-mrtr],
  [sdk-src], [sdk-testing].
- Claude Code: [cc-mcp], [cc-hooks], [cc-env]. Claude Desktop and Cowork: [claude-building],
  [claude-review], [claude-notes], [issue-41110], [issue-1046].
- LM Studio: [lms-docs], [lms-0317].

[versioning]: https://modelcontextprotocol.io/specification/versioning
[changelog]: https://modelcontextprotocol.io/specification/2026-07-28/changelog
[mrtr]: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
[elicitation]: https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
[tools]: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
[schema]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts
[security]: https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
[pypi-mcp]: https://pypi.org/project/mcp/
[sdk-versions]: https://py.sdk.modelcontextprotocol.io/protocol-versions/
[sdk-elicitation]: https://py.sdk.modelcontextprotocol.io/handlers/elicitation/
[sdk-dependencies]: https://py.sdk.modelcontextprotocol.io/handlers/dependencies/
[sdk-mrtr]: https://py.sdk.modelcontextprotocol.io/handlers/multi-round-trip/
[sdk-src]: https://github.com/modelcontextprotocol/python-sdk/tree/v2.2.0
[sdk-testing]: https://py.sdk.modelcontextprotocol.io/get-started/testing/
[cc-hooks]: https://code.claude.com/docs/en/hooks#elicitation
[cc-mcp]: https://code.claude.com/docs/en/mcp
[cc-env]: https://code.claude.com/docs/en/env-vars
[claude-building]: https://claude.com/docs/connectors/building
[claude-notes]: https://support.claude.com/en/articles/12138966-release-notes
[issue-41110]: https://github.com/anthropics/claude-code/issues/41110
[claude-review]: https://claude.com/docs/connectors/building/review-criteria
[issue-1046]: https://github.com/anthropics/claude-ai-mcp/issues/1046
[lms-docs]: https://lmstudio.ai/docs/app/mcp
[lms-0317]: https://lmstudio.ai/blog/lmstudio-v0.3.17
