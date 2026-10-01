# PLAN-mcp: a local MCP server for curatune

Status: approved with adjustments (2026-10-01). Phase 0 done; phase 1 implemented and tested, live checks
pending (see the phase 1 status below).
Branch: this worktree's own branch (not `main`). Merge to `main` only with the user's explicit OK.
All sources were accessed on 2026-10-01 and are listed at the end.

**Naming.** The project is renamed from spotikit to **curatune** (section 2.3). This plan uses the new
names throughout:
- package and module `curatune`, CLI `curatune`;
- extra `curatune[mcp]`;
- MCP server `curatune`, console script `curatune-mcp`;
- the product's environment variables `CURATUNE_*`;
- resources under `curatune://`.

The rename of the library itself is **not** part of this plan. It happens on `main`, in a separate
session, before phase 1. This branch then syncs with `main` (section 10).
- `SPOTIFY_CLIENT_ID` and `SPOTIFY_REDIRECT_PORT` name Spotify settings, not the product, so they keep
  their names unless the rename session decides otherwise.
- The sibling project is still called spotikit-web here; its own name is decided there.

## 0. Context

curatune is a deterministic library plus a thin JSON CLI; an agent supplies the judgment through the
project skill. The library was designed to be wrapped as an MCP server without a rewrite. This plan adds a
**local (stdio) MCP server** as a second thin entry point next to `cli.py`, shipped as the optional extra
`curatune[mcp]`. It is a learning and portfolio project, so the design and its documentation matter as
much as the result.

In MCP, the tool descriptions and server instructions replace the skill. The confirmation rules in
`AGENTS.md` must hold in clients the CLI never had to consider: Claude Desktop, LM Studio, and Claude Code
through MCP. They must also hold when the model is wrong or manipulated by third-party text.

## 1. Goals and non-goals

Goals
- G1. Expose curatune's playlist operations as MCP tools with the same semantics as the CLI, without
  relaxing any confirmation rule.
- G2. Make plan application need a human confirmation that the model cannot produce, forge, or skip, on
  every target client (Claude Code, Claude Desktop, LM Studio).
- G3. Keep the library usable without MCP: `import curatune` and the CLI never import the `mcp` package.
- G4. Test everything that does not need a real client with an in-memory MCP client and the fake playlist
  API, in CI on Windows and Linux. Verify against real clients and the test playlist only where a test
  cannot reach.
- G5. Document the architecture and its decisions (confirmation, prompt injection, API facts verified
  live) to portfolio standard.

Non-goals
- A remote MCP server (see D1). Playback, library, or listening history. Changing visibility. Deleting
  playlists. Any change to `../spotikit-web` (impacts are only listed in section 9). The library rename
  (done on `main` separately).

## 2. Verified facts

### 2.1 Specification and SDK

- The current MCP revision is **2026-07-28** ([versioning]). Its key changes, from the [changelog]:
  - no `initialize` handshake and no protocol sessions; each request carries its version and client
    capabilities in `_meta`; servers MUST implement `server/discover`;
  - **Multi Round-Trip Requests (MRTR)** replace server-initiated requests, so elicitation is returned
    as an `InputRequiredResult` and answered on a retry of the same `tools/call`;
  - roots, sampling, and logging are deprecated;
  - cross-call state is carried in server-minted handles passed as ordinary arguments.
  - Our `plan_id` is exactly such a handle.
- Elicitation ([elicitation]):
  - form mode schemas are flat and primitive only;
  - servers MUST NOT ask for secrets in form mode;
  - clients MUST show which server is asking and offer decline and cancel;
  - the answer is `accept` / `decline` / `cancel`;
  - `requestState` is attacker-controlled input that servers MUST integrity-protect, and single use must
    be enforced server-side ([mrtr]).
- Tool annotations ([schema], [tools]) are `title`, `readOnlyHint` (default false), `destructiveHint`
  (default true), `idempotentHint` (default false), and `openWorldHint` (default true). They are hints,
  and "clients MUST consider tool annotations to be untrusted unless they come from trusted servers". The
  spec says there SHOULD always be a human in the loop able to deny tool invocations.
- The official Python SDK is **`mcp` 2.2.0**, released 2026-09-07 ([pypi-mcp]). It is the v2 line:
  - the high-level server class is `MCPServer`;
  - it serves both protocol eras;
  - **resolvers** (`Annotated[T, Resolve(fn)]` returning `Elicit(...)`) ask the user on either era: as a
    live `elicitation/create` on legacy connections, as MRTR on 2026-07-28 ([sdk-elicitation],
    [sdk-dependencies]);
  - a resolved parameter is not in the input schema, and a value a client sends for it is ignored
    ([sdk-dependencies]);
  - eliciting from a client that did not declare the capability fails with `-32021`;
  - `ctx.client_capabilities` and `ctx.protocol_version` are available to handlers ([sdk-src]);
  - `requestState` is sealed (encrypted and authenticated) by default with a process-local key
    ([sdk-mrtr]);
  - plain `def` tools run in a worker thread ([sdk-src]);
  - `@mcp.tool(annotations=..., meta=...)` takes annotations and `_meta`;
  - `Client(server)` connects in memory for tests, and `mode="legacy"` forces the old handshake
    ([sdk-testing], [sdk-versions]).
- The SDK's runtime dependencies are heavy: starlette, uvicorn, sse-starlette, httpx2, pyjwt[crypto],
  jsonschema, opentelemetry-api, and pywin32 on Windows ([sdk-src]). That is a reason to keep it an
  optional extra.

### 2.2 Client support matrix

| Client | MCP role | Elicitation | Annotations | Other relevant facts |
|---|---|---|---|---|
| **Claude Code** (CLI) | host | **Verified**: form and URL; a dialog appears automatically ([cc-mcp]) | Not documented as changing permissions | Every elicitation can be auto-answered by an **`Elicitation` hook** ([cc-hooks]). `_meta["anthropic/requiresUserInteraction"]: true` forces a permission prompt on every call, even in bypass modes (v2.1.199+). stdio servers stay on the legacy handshake unless `MCP_PROTOCOL_NEGOTIATION=auto` ([cc-mcp], [cc-env]). Default tool-result limit is 25,000 tokens. Loads server instructions at session start. |
| **Claude Desktop** (chat) | host | **No evidence of support** | **Documented for connectors**: "`readOnlyHint` … `destructiveHint` … determine auto-permissions in Claude. Read-only tools can run without per-call confirmation, and destructive tools always prompt" ([claude-review]). Phase 1 checks it for a local server. | The connector guide lists tools, prompts, and resources, and doesn't mention elicitation ([claude-building]). Release notes to September 2026 don't mention it ([claude-notes]). The feature request was closed as "invalid" (wrong repository), not resolved ([issue-41110]). That is absence of evidence, not proof: phase 1 checks what Desktop actually declares. **MCP Apps supported** ([ext-matrix]). Tool results are capped at about 150,000 characters, with a 240 s timeout ([claude-building]). |
| **Cowork** (Claude Desktop) | host | **Known broken**: declares `elicitation` but drops the request, and the call hangs 180 s (open since 2026-09-16, [issue-1046]) | — | Capability detection can't catch this case. |
| **LM Studio** ≥ 0.3.17 | host (Cursor's `mcp.json` format; local and remote servers) | **Not documented**: docs cover tools only ([lms-docs], [lms-0317]) | Not documented | Shows a per-call confirmation dialog with editable arguments and an "always allow" option ([lms-0317]). A stdio server must run on the same machine as LM Studio. spotikit-web's evaluations show that small local models confuse 0-based positions and invent IDs. |
| MCP Inspector, Python SDK `Client` | test clients | Supported | — | Used in tests only. |

Consequence: today **only Claude Code in a terminal confirms through elicitation**. In Claude Desktop and LM
Studio the fallback is the main path, not an edge case.

### 2.3 Naming: curatune

The [spotify-design] guidelines say:
- an app name "should not include 'Spotify' or be similar to 'Spotify' in sound or spelling";
- "Don't incorporate Spotify's trademarks, in whole or in part, in the name of your company, product,
  application, service, or website";
- "for Spotify" is acceptable.

The old name's "Spoti-" prefix conflicted with this, so the user renamed the project **curatune**. A
description such as "curatune, a playlist toolkit for Spotify" stays within the guidelines.
- The rename happens on `main` in a separate session, before phase 1. This branch then syncs (section 10).
- The repository's name and spotikit-web's name are affected too, and are decided outside this plan.
- The phase 5 PyPI step re-checks the published name and description against the guidelines.

## 3. Decisions

Each decision lists the alternatives discarded and why.

**D1. Local stdio only; a remote server is a conscious non-goal.**
A remote server would need all of the following:
- **Hold third parties' Spotify tokens.** "The MCP server is responsible for storing and managing the
  third-party tokens", and it "MUST NOT transmit" them to the client ([elicitation]). Token passthrough
  is forbidden ([security]). That means encrypted refresh tokens at rest for every user, and a breach
  exposes all of them.
- **Run two OAuth systems.** It would be an OAuth client of Spotify and also an MCP authorization server
  or resource server: protected resource metadata, Client ID Metadata Documents (the 2026-07-28 changelog
  deprecates Dynamic Client Registration), and `iss` validation ([changelog]).
- **Lose the local confirmation page.** Its replacement, URL elicitation, carries a phishing risk: the
  server MUST verify that the user who opens the URL is the one who started the request ([elicitation]).
- **Operate a public service:** TLS, uptime, monitoring, rate limiting, and abuse handling.
- **Live within Spotify's caps.** Development Mode allows at most 5 users per app, and the quota is shared
  per developer account. A public server would serve at most five people.

spotikit-web already covers "zero install for someone else". Discarded: a remote server behind Cloudflare
Access for the user alone, which is all operational cost and teaches nothing new about MCP.

**D2. A thin entry point in the same package, as an optional extra.**
- New subpackage `src/curatune/mcp_server/`, a sibling of `cli.py`.
- Console script `curatune-mcp`.
- Extra `mcp = ["mcp>=2.2,<3"]`.
- Running `curatune-mcp` without the extra prints an "install `curatune[mcp]`" error.

The subpackage contains the tool registrations (as thin as `cli.py`), the numbering module (D4), and the
confirmation machinery (D3), which is the one genuinely new piece. It contains no Spotify logic. A static
test enforces that `mcp_server` never imports `_writes` or `requests`, and that `curatune`/`curatune.cli`
never import `mcp`.

Discarded:
- **A separate project or repository:** it would duplicate packaging, and the library was built for this.
- **A single `mcp_server.py`:** the confirmation page and store would bloat it past `cli.py`.
- **Naming it `curatune/mcp/`:** it reads as if it shadows the `mcp` package.

**D3. Confirmation model.**
Plans stay the only path to remove, reorder, or rename. `plan_apply` applies only after a human answers on
a surface the model cannot write to. The route is chosen per call:
1. **Elicitation**, when the client declares form elicitation. A resolver asks a server-rendered question.
   Built first (phase 2a).
2. **MCP App plan viewer**, only for Claude Desktop and only if the gate in phase 3 passes.
3. **Local page plus one-time code** (the user's choice; phase 2b).
   - The server itself opens the browser on `http://127.0.0.1:<random port>/confirm/<random token>`.
   - The page renders the plan from the plan file.
   - **Approve** reveals a one-time code, which the user pastes in the chat.
   - The model then calls `plan_apply(plan_id, confirmation_code)`.

The override `CURATUNE_MCP_CONFIRM=auto|elicitation|browser` covers clients that declare elicitation and
drop it, as Cowork does. Details are in section 5.

Discarded:
- **Approve button with no code:** the approval would not be tied to a chat, and Claude Desktop uses one
  server process for all chats.
- **No fallback, apply through the CLI:** Desktop and LM Studio could never apply.
- **The client's own tool-approval prompt alone:** it shows only `plan_id`, and LM Studio offers "always
  allow".
- **No apply tool, as in spotikit-web:** MCP has no UI of ours except elicitation, the page, or an App.
- **A native OS dialog (tkinter):** missing on some Python builds and unreliable from background
  processes on macOS.

**D4. Track numbers are 1-based at the MCP boundary.**
- Tools take and return `number` (1 = first track, as in the Spotify app) for playlist items.
- One module, `mcp_server/numbering.py`, has its own tests and converts both ways: arguments, item views,
  plan views, warnings and error details that carry positions (`positions`, `missing[].position`,
  `from_position`), and range checks.
- The library, plan files, the CLI, and `docs/reference.md` stay 0-based.
- Search `offset` is a count, not a position, and stays as is.
- Evidence: spotikit-web's evaluation, where a 9B model read 0-based positions as track numbers; the web
  uses 1-based `number` too.

Discarded: 0-based for consistency with the CLI. Every model would have to convert, and small local models
do it wrong.

**D5. One per-user data directory, shared by the CLI and MCP (phase 3, before packaging).**
- In v1 and v2 the server runs from the worktree's `.venv`, a source checkout. It uses the checkout's
  `data/` and `plans/`, exactly like the CLI from the same checkout. In this worktree that is its own
  gitignored `data/`, separate from the main checkout's real data.
- `Settings.data_dir` holds `plans/`, `backups/`, `write_log.json`, and `recordings.json`.
- Resolution: `CURATUNE_DATA_DIR` if set, otherwise `%LOCALAPPDATA%\curatune\data` on Windows or
  `$XDG_DATA_HOME/curatune` (default `~/.local/share/curatune`) elsewhere.
- Never the repository root or the current directory.
- **Legacy guard:**
  - In a source checkout whose `data/` or `plans/` has files, a default data dir without them makes every
    command that uses the data dir fail with `LEGACY_DATA_NOT_MIGRATED`.
  - With an explicit `CURATUNE_DATA_DIR`, the user's choice stands, and commands emit the warning
    `LEGACY_DATA_PRESENT`.
  - `auth status` reports the state without failing.
  - curatune never starts empty silently.
- New CLI command `curatune data migrate`:
  1. backs up the legacy folders to `data_dir/migration-backup-<UTC timestamp>/`;
  2. copies (never moves) them into `data_dir`, refusing to overwrite;
  3. verifies the result by file hashes and counts;
  4. leaves the originals in place.
- Deleting the originals is a separate step, done only with the user's OK.
- The cutover is described in section 10, phase 5.
- From phase 3 on, development sets `CURATUNE_DATA_DIR` to a test directory outside the repository, never
  the real one.

Discarded:
- **An MCP-only directory:** two write logs would blind the read-lag compensation to the other entry
  point's writes, and there would be two recording stores.
- **Keeping repo `data/` as the default:** the request rules it out.
- **Moving the files automatically on first run:** silent changes to user data.

**D6. Configuration without a project root (phase 3, with D5).**
- `project_root` exists only in a source checkout: `CURATUNE_PROJECT_DIR`, or `pyproject.toml` beside
  `src/`. Otherwise it is `None`, instead of falling back to the current directory.
- `.env` is read from the checkout root and from the config dir (the token dir). Process environment
  wins over both.
- The "token outside the repository" check runs only when a checkout exists. Today it misfires when an
  installed server's working directory is the home directory, because the token dir is inside it.
- This only matters for installed (non-checkout) servers, so it lands with packaging. In v1 and v2 the
  server always runs from the checkout.

Discarded: keeping the cwd fallback, which is wrong for any client-launched process.

**D7. Tool surface: the same names as spotikit-web, and safety enforced in code.**
- Names mirror spotikit-web: `playlists_list`, `playlist_show`, `search_tracks`, `search_many`, …, so the
  two projects can share evaluation scenarios.
- **No visibility parameter anywhere.** `playlist_create` has no `public` option and always requests
  private, as in spotikit-web.
- **No file-path inputs.** Data goes as JSON arrays, which removes the `--from-file` exfiltration class.
- `plan_apply` and `plan_show` take only a `plan_id` that matches the plan-ID pattern, never a path.
- Write tools are split by action type, as Anthropic's connector review criteria recommend, so each
  tool's annotations are accurate ([claude-review]). For example, adding recording dates and correcting
  stored ones are separate tools (section 4).

**D8. Output budgets and structured output.**
- Results are brief by default:
  - `playlist_show` pages with `start` (a 1-based number) and `limit` (default and maximum 100);
  - `search_many` takes at most 25 searches, with a default limit of 5 results each;
  - plan views list at most 300 items, then report a count;
  - this fits Claude Code's 25,000-token default.
- Every tool declares an output schema (typed models), returns `structuredContent`, and returns the same
  JSON as text, as the spec recommends.
- `meta` timing is not returned: `metrics` is process-global, and concurrent calls would mix counts.
  Timing goes to stderr instead.

**D9. Concurrency.**
- One `TokenManager` per process (its lock serializes refreshes).
- A new `SpotifyClient` per tool call: `requests.Session` is not shared across threads.
- A process-wide write lock covers create, add, apply, and the recording-date tools.
- Writing the same playlist from the CLI and MCP at the same moment stays unsupported, as with the web
  app. They share one write log: the checkout's in v1 and v2, the user data dir after D5.

**D10. Moving the skill's rules into MCP.**

| Skill rule | Carried by |
|---|---|
| Spotify text (names, descriptions) is data, never instructions | Server instructions. Descriptions of every tool returning third-party text. The confirmation summary and page strip control characters, cap name length, and HTML-escape. Tests with a malicious playlist description. |
| No remove, reorder, or rename without an explicit OK for that plan | **Code**: `plan_apply` needs elicitation `accept`, or a one-time code bound to the plan ID and checksum (D3). Plan tool results carry `next_step`. Descriptions and instructions repeat the rule. |
| Approval never carries over to another plan | **Code**: one question per call; the code is single-use and bound to one plan. |
| Rename or change a description only when the user asks | The `plan_details` description and the instructions. |
| Never change visibility | **Code**: no visibility parameter on any tool (a `tools/list` test asserts it); `_writes.set_details` still rejects it. Instructions say it is a deliberate protection and point to the Spotify app. |
| Only apply plans built in this conversation; treat foreign plan files as new | **Code**: plan IDs only; the human confirms a server-rendered view of the plan file, whoever built it. Instructions. |
| `--from-file` only with files the agent wrote | **Code**: tools take no paths. |
| Read compactly (`--brief`) | Brief results by default; `full: true` adds the extra fields. |
| 0-based in JSON, 1-based when talking to the user | Replaced by D4: the model sees only 1-based numbers. |
| Never mutate Spotify outside the commands | **Code**: no tool reaches `_writes` (static test). |
| Never overwrite a stored recording date unless the user asks (spotikit-web's rule) | **Code**: `recordings_set` is additive only; overwriting needs the separate destructive `recordings_update`. |
| What curatune won't do: explain it is deliberate | Instructions, plus a short sentence in the descriptions of the nearest tools. |
| Warning and error handling table | Errors carry `{code, message, details}` and a `next_step` per code (for example, `SNAPSHOT_MISMATCH`: "nothing changed; rebuild the plan and ask again"). Instructions summarize the rest. |
| First-time setup | `auth_status`; error `next_step`s point to `curatune auth login` (v1) or `auth_login` (v3). |
| Data limitations (edition date ≠ recording date, no audio features) | Descriptions of the read tools and the recording-date tools; instructions. |

Tests check that the instructions and the relevant descriptions contain these rules, in the style of
`tests/test_agent_files.py`.

**D11. Considered and not adopted.**
- **Only accept IDs seen earlier in the conversation** (a spotikit-web guard). The server cannot see the
  conversation, and in Claude Desktop one process serves every chat. Instead, `playlist_add` re-reads the
  playlist and returns the name of each added track, so a wrong ID is visible at once.
- **A live applicability check before the question.** Under MRTR the resolver re-runs every round, which
  would cost a playlist read per round, and `plan_apply` re-verifies anyway: a stale plan changes nothing
  (`SNAPSHOT_MISMATCH`).
- **Caching playlist reads between pages.** Snapshot read lag would make a snapshot-keyed cache serve
  stale items after a write. `playlist_show` re-reads and slices; a 271-item playlist costs 8 requests
  per page, which is acceptable.

## 4. Tool design

The server is called `curatune`. All inputs are validated. Unknown keys inside nested objects (`searches`,
`entries`) are rejected; unknown top-level arguments are ignored, which is the SDK's behaviour (found in
phase 1). Ignoring is safe: an extra `public` or `confirm` argument has no effect.
- `<playlist>`, `<track>`, and `<album>` accept a bare ID, a `spotify:` URI, or an `open.spotify.com` URL.
- Errors are tool execution errors (`isError: true`) with text
  `{"error": {"code", "message", "details"}, "next_step": "…"}`. Positions inside them are already
  converted to numbers.

Annotation columns: RO = `readOnlyHint`, D = `destructiveHint`, I = `idempotentHint`, OW = `openWorldHint`.

| Tool | Phase | Inputs | Output (structured) | RO | D | I | OW | Notes |
|---|---|---|---|---|---|---|---|---|
| `auth_status` | v1 | — | `{authorized, reason?, next_step?}`. `reason` is one of `AUTH_REQUIRED`, `AUTH_EXPIRED`, `MISSING_SCOPES`, `CONFIG_ERROR`, and from phase 3 `LEGACY_DATA_NOT_MIGRATED`. | ✓ | – | ✓ | ✗ | No network, token path, or user ID. |
| `playlists_list` | v1 | `owned_only=false` | `{count, playlists:[{id,name,owner_name,owned,collaborative,public,item_count,url}], warnings}` | ✓ | – | ✓ | ✓ | Names are third-party text (description says so). |
| `playlist_show` | v1 | `playlist`, `start=1`, `limit=100` (≤100), `full=false` | `{playlist:{…}, items:[{number,uri,name,artists,album,released,duration,isrc,playable}+full fields], total, next_start, warnings}` | ✓ | – | ✓ | ✓ | Reads without a market unless `CURATUNE_MARKET` is set (as the CLI). |
| `search_tracks` | v1 | `query?`, `track?`, `artist?`, `album?`, `year?`, `limit=10` (≤10), `offset=0` | `{query, total, next_offset, results:[brief], warnings}` | ✓ | – | ✓ | ✓ | `YEAR_IS_RELEASE_YEAR` stays. |
| `search_many` | v1 | `searches:[{id?,query?,track?,artist?,album?,year?,limit≤10 (default 5)}]` (1–25) | `{count, failed, searches:[{id, ok, results \| error}]}` | ✓ | – | ✓ | ✓ | Uses the library's batch search (≤4 concurrent). |
| `track_show` | v1 | `track` | `{track: full Track}` | ✓ | – | ✓ | ✓ | |
| `album_tracks` | v1 | `album`, `full=false` | `{album, tracks:[brief]}` | ✓ | – | ✓ | ✓ | |
| `recordings_show` | v1 | `playlist` | `{playlist:{id,name}, items:[{number,uri,name,artists,recorded,confidence,source}], missing:[{number,uri,name}], chronological}` | ✓ | – | ✓ | ✓ | |
| `recordings_set` | v1 | `entries:[{uri,recorded,confidence,source,note?,name?,artists?,isrc?}]` (1–100) | `{created, skipped:[uri], total}` | ✗ | ✗ | ✓ | ✗ | **Additive only**: entries already stored are skipped and listed, never changed. Local store only. |
| `recordings_update` | v1 | same `entries`, (1–100) | `{created, updated, total}` | ✗ | ✓ | ✓ | ✗ | Overwrites stored entries (and creates missing ones). Description: only when the user asks to correct a stored date. |
| `playlist_create` | v1 | `name`, `description=""`, `allow_duplicate_name=false` | `{playlist:{id,name,url,public}, warnings}` | ✗ | ✗ | ✗ | ✓ | No `public` option. `VISIBILITY_NOT_APPLIED` explains the playlist is public. `DUPLICATE_NAME`: ask the user first. |
| `playlist_add` | v1 | `playlist`, `tracks:[ref]` (1–100), `at_number?` (1..count+1), `allow_duplicates=false` | `{playlist_id, added:[{number,uri,name,artists}], skipped:[{uri,reason}], item_count, verified, warnings}` | ✗ | ✗ | ✗ | ✓ | Re-reads the playlist to verify and to name the added tracks (`ADD_NOT_VERIFIED` when the read differs). |
| `plan_remove` | v2a | `playlist`, `numbers:[int]`, `reason?` | `{plan_id, kind, playlist:{id,name}, remove:[{number,name,artists}], tracks_before, tracks_after, warnings, next_step}` | ✓¹ | – | ✗ | ✓ | |
| `plan_reorder` | v2a | `playlist`, exactly one of: `order:[number]` (all current numbers in the new order), `move_from`+`move_to`, `sort_by` (+`descending`); `reason?` | `{plan_id, kind, playlist, new_order:[{number,was,name,artists}] (≤300, then a count), operations, warnings, next_step}` | ✓¹ | – | ✗ | ✓ | `sort_by` uses the rules in section 8. `RECORDING_DATES_MISSING` lists numbers. |
| `plan_details` | v2a | `playlist`, `name?`, `description?`, `reason?` | `{plan_id, kind, playlist, changes:{field:{from,to}}, warnings, next_step}` | ✓¹ | – | ✗ | ✓ | Only when asked. Visibility is not an option. |
| `plan_show` | v2a | `plan_id`, `check=true` | `{plan: view, applied, check?:{applicable, …}}` | ✓ | – | ✓ | ✓ | Any plan in the data dir, shown 1-based, without raw operations. |
| `plan_apply` | v2a (elicitation), v2b (`confirmation_code`) | `plan_id`, `confirmation_code?` | `{status: applied \| declined \| cancelled \| awaiting_user_confirmation, result?: {verified, operations_done, current?}, warnings, next_step}` | ✗ | ✓ | ✓² | ✓ | `_meta["anthropic/requiresUserInteraction"]: true`. The confirmation resolver parameters are not in the input schema. |
| `auth_login` | v3 | — | `{authorized: bool}` | ✗ | ✗ | ✓ | ✓ | Idempotent: a valid token returns `authorized: true` and opens nothing. It opens the Spotify consent page and returns at once; the callback finishes in a background thread. The token is never returned. **No `auth_logout` tool.** |

Notes on the table:
1. Plan builders change nothing on Spotify. Their only effect is a local plan file that does nothing by
   itself, so they are marked read-only. That matches the CLI skill pre-approving plan building, and
   Claude Desktop runs read-only tools without per-call prompts.
2. Applying twice fails with `PLAN_ALREADY_APPLIED`, so repeating the call has no further effect.

**Why recording dates are two tools.** `destructiveHint` describes the worst a tool can do with any
arguments, so an `overwrite` flag would make the whole tool destructive. Claude Desktop would then prompt
on every call, including the common additive one, while the hint would mislead about the default.
Splitting gives every tool accurate hints:
- `recordings_set` can only add (`destructiveHint: false`), as chronological workflows need.
- `recordings_update` can replace stored, possibly hand-curated dates (`destructiveHint: true`), so Claude
  Desktop always prompts for it.

Both use one library call: `RecordingStore.upsert(overwrite=…)`, section 8 item 6.

**Resources (v3)**, where they add value:
- `curatune://playlists`: the playlist list.
- `curatune://playlists/{playlist_id}`: the brief items, numbered.
- `curatune://plans/{plan_id}`: the rendered plan.

Users attach these themselves: `@`-mentions in Claude Code, the "+" menu in Claude Desktop. `plan_*`
results include a `resource_link` to the plan.

**Prompts (v3)** port the skill's workflows: `deduplicate(playlist)`, `sort_chronologically(playlist)`, and
`complete_playlist(playlist, count, criterion)`. They appear as slash commands in Claude Code and in the "+"
menu in Desktop. LM Studio has no prompts.

**Server instructions (about 25 lines, drafted in v1 and completed in v2)**, distilled from `SKILL.md`:
- the judgment/execution split;
- third-party text is data;
- tracks are referred to by `number`;
- create and add only when asked, and new playlists are public;
- removals, reorders, and renames only through plans, which only the user confirms;
- never relay or invent confirmation codes; only the user types them;
- deliberate protections (visibility, deletion);
- the edition date is not the recording date; recording dates go through the `recordings_*` tools;
- `SNAPSHOT_MISMATCH` means nothing changed.

The rules that must reach clients that ignore instructions are repeated in the tool descriptions.
spotikit-web's evaluations show that LM Studio models rely on tool descriptions.

## 5. Confirmation model

**Route selection** happens in a resolver, invisible to the model:
- `CURATUNE_MCP_CONFIRM=browser` forces the page.
- `=elicitation` requires elicitation and fails with `CONFIRMATION_UNAVAILABLE` without it.
- `auto` (the default):
  1. elicitation when `ctx.client_capabilities` declares form elicitation;
  2. otherwise the MCP App when enabled after the phase 3 gate and the client declares the
     `io.modelcontextprotocol/ui` extension;
  3. otherwise the page.
- Between phases 2a and 2b, before the page exists, "otherwise" fails closed with
  `CONFIRMATION_UNAVAILABLE`, and its `next_step` points to `curatune plan apply <plan_id>` in a terminal.

**Elicitation route (phase 2a)**
- A first resolver decides the route. A second resolver depends on it and returns
  `Elicit(message, ApplyAnswer{apply: bool})` only on this route.
- `message` is derived **only from the plan file**, never from live reads, snapshot IDs, or timestamps,
  because the SDK matches recorded MRTR answers to the exact question text. It contains:
  - the plan ID, the playlist name, and the counts before and after;
  - removed items (number, title, artists), moves (from → to), or the old and new name and description;
  - each third-party string stripped of control characters and line breaks, capped at 80 characters, and
    quoted;
  - at most 25 lines, then "… and N more".
- Outcomes:
  - `accept` with `apply=true`: take the write lock, then run `plans.apply_plan`, which checks the
    snapshot and the items, backs up, applies, and verifies, all unchanged;
  - `accept` with `apply=false`, or `decline`: `declined`;
  - `cancel`: `cancelled`;
  - in every case except the first, nothing is applied.
- Legacy connections: an elicitation never answered leaves nothing applied, and the client's tool timeout
  ends the call. Under MRTR, an unanswered question simply never retries. Either way the failure is safe.

**Page and code route (phase 2b)**
1. `plan_apply(plan_id)` validates the plan (schema, checksum, consistency, not applied).
2. It creates a confirmation bound to `plan_id` plus `checksum`, with a TTL of 10 minutes, at most 3 code
   attempts, and single use.
3. It starts, if needed, a `127.0.0.1`-only HTTP server on an ephemeral port, in a daemon thread.
4. It opens the browser itself (`webbrowser.open`). The URL carries a random token (32 bytes,
   `secrets.token_urlsafe`). **Neither the URL nor the code ever appears in a tool result, a log, or
   stderr.**
5. It returns `awaiting_user_confirmation`, and its `next_step` tells the model to ask the user to review
   the page and paste the code shown after Approve. If the browser cannot be opened, the call **fails
   closed** with `CONFIRMATION_UNAVAILABLE`, and its `next_step` gives the user a CLI alternative:
   `curatune plan apply <plan_id>` in a terminal.
6. The page:
   - renders the plan from the plan file: before and after, removed and moved items, numbers 1-based;
   - is HTML-escaped and fully static, with no JavaScript;
   - sends `Content-Security-Policy: default-src 'none'; style-src 'nonce-…'; form-action 'self'; frame-ancestors 'none'`.
7. Approve and Reject are `POST`s that require:
   - a `Host` header of exactly `127.0.0.1:<port>`, which defeats DNS rebinding ([security]);
   - an `Origin` matching it;
   - the per-page nonce.
8. Approve shows a code of 8 Crockford base32 characters (`XXXX-XXXX`, 40 bits). The code is compared in
   constant time, ignoring case and hyphens.
9. `plan_apply(plan_id, confirmation_code)`:
   - verifies the checksum and code, then consumes the confirmation before applying;
   - a wrong code uses up one attempt, and the third wrong one voids the confirmation;
   - Reject voids it, and the result says the user rejected the plan.
10. Pending confirmations live in memory. A server restart drops them, and the user approves again.

**MCP App route (phase 3, only if its gate passes).** In Claude Desktop, `plan_apply` returns a plan
viewer. Its Apply button calls an app-only tool (`visibility: ["app"]`) with a per-render nonce, and that
tool applies the plan. The outcome reaches the model through the app's context update, much like
spotikit-web's Apply button and `[App notice]`. For Claude Desktop this replaces the page and the code; the
page stays for LM Studio and as the override.

**Security properties and the threat model**
- What the design defends against:
  - a model that is wrong or manipulated by third-party text (track names, playlist descriptions,
    foreign plan files);
  - a model that tries to apply without the user, invents a code, or replays one.
- In-scope guarantees:
  - the question the human sees is rendered by the server from the checksummed plan file, not
    paraphrased by the model;
  - the answer arrives through a client UI or the user's own typing;
  - it is single-use and bound to one plan;
  - `plan_apply` re-verifies the live playlist anyway.
- Outside the boundary, documented and not defended:
  - an agent with shell access acting adversarially (Claude Code can read the token file and call the
    API directly; no MCP design can stop that);
  - a client that answers elicitations on its own: a user-configured Claude Code `Elicitation` hook, or a
    host that routes elicitation to the LLM.
- Defense in depth:
  - `requiresUserInteraction` on `plan_apply` in Claude Code, so even under bypass modes a person sees
    the call, at the cost of a second prompt;
  - `destructiveHint` makes Claude Desktop always prompt;
  - the override `CURATUNE_MCP_CONFIRM=browser`.
- `plan_id` is a name, not a capability ([security], state handle hijacking). The human confirmation is
  the authorization.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A client declares elicitation and drops it (Cowork, `claude -p`) | Nothing is applied without an answer. `CURATUNE_MCP_CONFIRM=browser`. The capability probe in phase 1 records what each client declares. |
| A Claude Code `Elicitation` hook auto-accepts | Documented. `requiresUserInteraction` keeps a human prompt on `plan_apply`. |
| Prompt injection through Spotify text | Instructions and descriptions. Server-rendered confirmation with sanitized, escaped text. No tool takes paths. Tests with an injected playlist description. |
| The model asks the user for "the code" before any page exists, or pastes a code from elsewhere | Codes exist only after Approve on the page. Attempts are limited, and codes are bound to one plan and expire. |
| DNS rebinding or a CSRF against the local page | Bound to 127.0.0.1, a random path token, a `Host` and `Origin` check, a per-page nonce, CSP, and no CORS. |
| The browser can't open (headless, SSH) | Fail closed with `CONFIRMATION_UNAVAILABLE` and the CLI alternative. |
| `resolve_plan_path` escapes `plans_dir` (`../x`), or the MCP layer passes a path | Library hardening with a test (phase 2a). MCP accepts only the plan-ID pattern. |
| Large results exceed client limits (25,000 tokens in Claude Code) | Paging, caps, brief views (D8). |
| Concurrent tool calls corrupt the write log or race a token refresh | One `TokenManager` per process, a client per call, a write lock (D9). |
| v1/v2 development writes mix with the user's real data | During v1 and v2 the worktree's server and CLI use the worktree's own gitignored `data/`, separate from the main checkout's. From phase 3 on, `CURATUNE_DATA_DIR` points to a test directory. |
| The data-dir change (phase 3) hides the user's curated recording dates | Legacy guard, `data migrate` with a backup and verification, a cutover without other sessions open, deletion only with an OK (D5). |
| Installed servers (uvx, `.mcpb`) resolve configuration against the cwd | D6 lands in phase 3, before packaging. v1 and v2 run only from the checkout. |
| Live tests touch the user's curated playlists | Writes go only to the "curatune test" playlist recorded in this repository's `AGENTS.local.md` (its ID, initial state, and URIs in order). Restore that state after each test. spotikit-web keeps its own test playlist, and curatune never writes it. |
| SDK churn (v2 is weeks old) | Pin `mcp>=2.2,<3`. Tests and CI cover both protocol eras. |
| The rename lands on `main` while this branch is in progress | The rename is done only on `main` before phase 1. This branch holds only `PLAN-mcp.md` until then, so the sync is trivial. After syncing: reinstall the editable package, rename the worktree `.env` variables to `CURATUNE_*`, and re-run the baseline. |
| The new name or its descriptions drift toward Spotify's marks | Phase 5 re-checks the published name, description, and logo against [spotify-design] before publishing. |
| MCP App app-only tools are visible to the model in practice | Real-client gate in phase 3. If it fails, the App is dropped and the page stays. |
| CI can't run until the repository is on GitHub (there is no remote yet) | The workflow is written in phase 1 and its exact commands run locally. The first GitHub run happens when the user pushes the repository. |

## 7. Package layout

```
src/curatune/
  config.py           phase 3: data_dir, optional project_root, .env lookup, legacy guard (D5/D6)
  cli.py              + `plan reorder --sort-by KEY [--descending]` (2a), + `data migrate` (phase 3)
  ordering.py         new, pure: sort keys and comparison rules (section 8, item 7)
  mcp_server/
    __init__.py       main(): the curatune-mcp entry point; explains how to install the extra if missing
    server.py         build_server(settings, client_factory, tokens), runtime, result envelopes, next_step, probe
    tools.py          tool registrations: validate → numbering → library (in a thread) → view
    views.py          what the model sees: compact views of the library's results
    numbering.py      the only 0-based ↔ 1-based conversion (D4), with tests/test_mcp_numbering.py
    schemas.py        nested inputs and every tool's strict output model
    confirm.py        route selection, elicitation resolvers (2a), confirmation store (2b)
    approval_page.py  the local HTTP page (render, Host/Origin/nonce checks, CSP) (2b)
    instructions.py   server instructions text
  demo.py             phase 3: in-memory fake Spotify (promoted from tests/fakes.py) and synthetic seed data
.github/workflows/tests.yml   phase 1: CI matrix (section 10)
```

## 8. Impact on the library

Each item lists its phase and CLI-visible effect, and every item gets tests.

1. **Data directory and legacy guard** (D5, **phase 3**): `Settings.data_dir`, `CURATUNE_DATA_DIR`, the
   `LEGACY_DATA_NOT_MIGRATED` error and `LEGACY_DATA_PRESENT` warning, and the new `data migrate`
   command. The CLI changes where it reads and writes. Update README, `docs/reference.md`, `AGENTS.md`
   (gitignore notes), the skill (setup and error table), and `.env.example`.
2. **Configuration without a checkout** (D6, **phase 3**): `project_root` can be `None`; `.env` comes from
   the checkout or the config dir; the token-dir check runs only in a checkout. Settings tests change.
3. **`resolve_plan_path` hardening** (**phase 2a**): a bare reference must match the plan-ID pattern and
   stay inside `plans_dir`. File paths keep working for the CLI, as documented. New test for `..`.
4. **Batch search client factory** (**phase 1**): `search_tracks_batch` gets per-thread clients from
   `client.thread_client()` (the default creates a `SpotifyClient` with the same `TokenManager`) instead
   of building `SpotifyClient(client.tokens)`. This lets the fake and demo mode run batches. No visible
   change.
5. **`add_items` verification** (**phase 1**): after adding, it re-reads the playlist and returns
   `verified`, plus the names and artists of the added items. CLI `playlist add` gains those fields;
   document them.
6. **`RecordingStore.upsert(overwrite=True)`** (**phase 1**): with `overwrite=False`, existing entries are
   skipped and returned in `skipped`. The CLI default is unchanged. MCP's `recordings_set` passes `False`;
   `recordings_update` passes `True`.
7. **`sort_by` for reorders** (**phase 2a**; new `ordering.py`; `plan reorder --sort-by` with `title`,
   `artist`, `album`, `released`, `duration`, or `recorded`, plus `--descending`; `--by-recording-date`
   stays as an alias of `--sort-by recorded`). The comparison rules follow spotikit-web's `sortedOrder`
   and are documented in `docs/reference.md`:
   - text keys: title, the **first** artist, the album name;
   - leading characters that are neither letters nor digits are ignored (`'Round Midnight` sorts as
     `Round Midnight`);
   - one leading English article "The " is ignored, case-insensitively, and no other articles, in any
     language, for parity with the web;
   - comparison ignores case and accents (Unicode NFKD, combining marks dropped, casefold), so
     `Á` = `a`;
   - runs of digits compare as numbers (`Track 2` < `Track 10`);
   - `released` compares the edition's `release_date` string (`1945` sorts before `1945-11-26`);
   - `duration` compares milliseconds;
   - `recorded` uses the recording store (missing dates fail with `RECORDING_DATES_MISSING`, as today);
   - items without a value go last in both directions;
   - **ties keep their current order, in both directions** (`descending` reverses the comparison, not
     the tie-break).
   - Tests use a table of cases: case, accents, "The", leading punctuation, numbers, missing values,
     ties, and descending. These cases are written so they can serve as shared test vectors with the web.
   - Known divergence: ICU collation (web) versus this key for non-Latin scripts and punctuation order;
     documented.
   - Update `docs/reference.md`, README, and the skill (reorder workflow: prefer `--sort-by` to computing
     an order).
8. **Visibility, the confirmation rules, and the plan file format are unchanged.** Confirmations live in
   the MCP layer, so plan files carry no approval fields.

## 9. Impact on spotikit-web

To be evaluated by the web project; this repository does not change it.

- **Converging (differences the web can drop or reword):**
  - curatune now has `sort_by` with the web's rules, so drop that difference and compare the shared test
    vectors;
  - `playlist add` verifies and names added tracks, as the web's add already does;
  - MCP uses 1-based `number`, has no `public` option on create, and pages `playlist_show` at 100, as the
    web does.
- **New in curatune, to compare:**
  - `descending` with `sort_by: recorded` (the web supports `recorded` ascending only);
  - recording dates split into an additive `recordings_set` and a destructive `recordings_update`, where
    the web relies on the prompt not to overwrite;
  - `RecordingStore.upsert(overwrite=…)`.
- **Wording:** "spotikit's `data/` files" becomes "curatune's data directory" (`CURATUNE_DATA_DIR`) once
  phase 3 lands. `LEGACY_DATA_*` and `data migrate` are CLI-only.
- **Applying plans:** the web has no apply tool (UI button). curatune MCP has `plan_apply`, gated by
  elicitation, the page code, or the MCP App. With the App, the model learns the outcome like the web's
  `[App notice]`. Document this as a deliberate difference on both sides.
- **API facts:** none newly verified yet. Anything found during live MCP tests goes to both `AGENTS.md`
  files, per the web's rule.
- **Name:** the library's rename to curatune changes every reference the web makes to spotikit (module
  headers, the "Relationship to spotikit" section). The web's own name is decided there.

## 10. Phases, checklists, and "done when"

### Phase 0: environment (this stage)

- [ ] Write this plan as `PLAN-mcp.md` at the worktree root. Scan it for personal data.
- [ ] Create the worktree's own `.venv` and run `pip install -e ".[dev]"` (still the current package
      name). Then check that the package's `__file__` points into the worktree, not the main checkout.
- [ ] Copy `AGENTS.local.md` and `.env` from the main checkout (both gitignored). Leave the token alone.
- [ ] Run the existing suite in the worktree to get a green baseline.
- **Done when:** the baseline passes against the worktree's code and `PLAN-mcp.md` is in place. Then
  **stop**.

### Between phase 0 and phase 1: the rename (on `main`, by another session)

- [ ] When the user says the rename is on `main`, sync this worktree with `main` through the app's
      base-branch sync.
- [ ] Reinstall the editable package in the worktree's `.venv`.
- [ ] Rename the variables in the worktree's `.env` to `CURATUNE_*` as `main` did.
- [ ] Check that `import curatune` resolves into the worktree, and re-run the baseline.
- **Done when:** the baseline passes under the new name. Then start phase 1.

### Phase 1 (v1): reads, create and add, in-memory tests, CI

The server runs from the worktree's `.venv` and shares the checkout's `data/` with its CLI (D5 waits for
phase 3).

- [x] Library items 4, 5, and 6 (section 8), with tests.
- [x] Extras and entry point: `mcp = ["mcp>=2.2,<3"]`, the `curatune-mcp` script, and the friendly error
      without the extra.
- [x] `mcp_server/` with `numbering.py`, `tools.py` (v1 tools from section 4), `instructions.py`, and
      error mapping with `next_step`.
- [x] Capability probe: on each client's first request, log the protocol version, client name and
      version, and declared capability keys to stderr (no personal data).
- [x] Extend `tests/fakes.py` to several playlists, a catalog (search, track, album), `/me/playlists`,
      and create.
- [x] Tests:
  - [x] in-memory `Client(build_server(fake))`, parametrized over **both protocol eras** (default and
        `mode="legacy"`; no `raise_exceptions` in legacy);
  - [x] `tools/list`: deterministic order, annotations as in section 4, **no visibility or path
        parameter in any schema**;
  - [x] every tool's structured output validates;
  - [x] **no `position` key leaks** into any model-facing output;
  - [x] the numbering module's own tests;
  - [x] error mapping;
  - [x] `recordings_set` never changes a stored entry;
  - [x] instruction and description rule checks;
  - [x] a malicious playlist description passes through as data;
  - [x] static invariants: `mcp_server` doesn't import `_writes` or `requests`; `curatune` and
        `curatune.cli` don't import `mcp`;
  - [x] the suite passes with and without the extra (`pytest.importorskip("mcp")`).
- [x] **CI**: `.github/workflows/tests.yml` runs the suite as a matrix:
  - OS `windows-latest` and `ubuntu-latest`;
  - Python 3.10 (the minimum) and the newest supported version;
  - **without** the extra (MCP tests skip, and a test proves the CLI works without `mcp`) and **with**
    `curatune[mcp]` (MCP tests run in both protocol eras through the parametrized fixture).
  - `permissions: contents: read`, actions pinned to commit SHAs, no secrets; no test calls Spotify.
- [x] Docs: README (an MCP section with Claude Code and Claude Desktop configuration from the
      repository's `.venv`), `docs/reference.md` (the MCP contract or a new `docs/mcp.md`), `AGENTS.md`
      (MCP development notes and invariants), the skill (rows for the new add fields).
- [ ] Live check:
  - [ ] the server connected to **Claude Code and Claude Desktop**: list, show, and search work;
  - [x] live `playlist_create` and `playlist_add`, with the user's explicit OK: they created the test
        playlist itself ("curatune test", recorded in `AGENTS.local.md`), see the status below;
  - [ ] each client's capability-probe output recorded in this plan's matrix.
- [ ] **Optional: LM Studio.** A stdio server must run on the same machine as LM Studio. If LM Studio runs
      on another machine, that machine needs its own curatune install, `.env`, `auth login` (a second
      token for the same Development Mode user), and data. Document the requirement either way, and
      record the results if it is tried.
**Status (2026-10-01).**
- Done: everything above except the live checks. 413 tests pass with the extra (Windows, Python 3.10, both
  protocol eras); 357 pass and the MCP module is skipped without it. A mutation check (one view not
  converting positions) fails the tests in both eras. The CI workflow is written; its first run waits for
  the repository to be on GitHub.
- Live, protocol level: `curatune-mcp` started as a real stdio subprocess from an unrelated working
  directory negotiates 2026-07-28, lists 12 tools, reports `authorized: true`, and lists the account's
  playlists. The probe logged the SDK client as `mcp 0.1.0`, `capabilities={}`.
- The test playlists recorded for spotikit-web returned `NOT_FOUND` (also through the CLI); the user
  recovers that one. With the user's OK, curatune got its own: "curatune test", created over stdio with
  `playlist_create` (`VISIBILITY_NOT_APPLIED`: public, as expected) and loaded with the 12-track shuffled
  state in one `playlist_add` (`allow_duplicates`: the exact duplicate at numbers 2 and 7). The URIs came
  from the old playlist's entry in the main checkout's write log, each checked first with `track_show`.
  `playlist_add` returned `verified: true` with every track named; `playlists_list` right after emitted
  `ITEM_COUNT_READ_LAG`, confirming live, through MCP, that the playlist list lags behind writes. The ID,
  initial state, and URIs are in `AGENTS.local.md`, never here.
- Pending, by the user: connecting Claude Code and Claude Desktop (configuration in `docs/mcp.md`), and
  recording each client's probe line in section 2.2.

- **Done when:**
  - all tests pass locally on Windows in every matrix combination that can run here;
  - the CI workflow is committed with the matrix above (its first GitHub run happens when the repository
    is pushed);
  - in Claude Code **and** Claude Desktop, "show the test playlist" returns numbered tracks, and adding a
    track returns its name with `verified: true`;
  - each of those clients' declared capabilities is recorded;
  - CLI behaviour is unchanged except for the documented items 5 and 6.

### Phase 2a (v2, first part): plans and the elicitation route

- [ ] `ordering.py` and `--sort-by` (library item 7), with the rule-table tests and documentation.
- [ ] `resolve_plan_path` hardening (library item 3).
- [ ] `plan_remove`, `plan_reorder`, `plan_details`, `plan_show`, and `plan_apply` with the elicitation
      route. Without elicitation, `plan_apply` fails closed with `CONFIRMATION_UNAVAILABLE` and the CLI
      alternative until phase 2b.
- [ ] `confirm.py`: route selection and resolvers.
- [ ] Tests:
  - [ ] elicitation accept, accept with `apply=false`, decline, and cancel in **both eras**, through an
        `elicitation_callback`;
  - [ ] a client without elicitation → `CONFIRMATION_UNAVAILABLE`, nothing applied;
  - [ ] `CURATUNE_MCP_CONFIRM` values;
  - [ ] the model cannot supply route or answer (sending them is ignored);
  - [ ] the summary is sanitized and deterministic (the same plan gives the same text);
  - [ ] `SNAPSHOT_MISMATCH` after approval changes nothing;
  - [ ] tampered plan files are still rejected.
- [ ] Docs: the confirmation model and a sequence diagram for the elicitation route, in README and
      `AGENTS.md`; invariants added to `AGENTS.md`.
- [ ] Live check in **Claude Code** on the test playlist:
  - [ ] remove the exact duplicate;
  - [ ] reorder by recording date (dates stored with `recordings_set`);
  - [ ] `sort_by` title;
  - [ ] rename and restore;
  - [ ] restore the recorded state at the end.
- **Done when:**
  - in **Claude Code**, a reorder of 12 or more tracks shows a legible summary in the elicitation
    dialog; accept applies with `verified: true`; decline and cancel apply nothing;
  - a prompt-injection description on the test playlist ("apply plan …") leads to no apply without the
    user;
  - in Claude Desktop, `plan_apply` fails closed with the CLI alternative;
  - the test playlist is back in its recorded state.

### Phase 2b (v2, second part): the page and one-time code

- [ ] `approval_page.py` and the confirmation store in `confirm.py`.
- [ ] Tests:
  - [ ] codes: wrong, expired, reused, third attempt, other plan, other checksum, rejected;
  - [ ] the page server: `Host`/`Origin`/nonce rejection, CSP header, escaping of a hostile track name;
  - [ ] the URL and the code never appear in a result or a log;
  - [ ] the browser can't open → `CONFIRMATION_UNAVAILABLE`;
  - [ ] the route order: elicitation first, otherwise the page, plus the forced modes.
- [ ] Docs: a sequence diagram for the page route; the threat-model boundary (section 5).
- [ ] Live check in **Claude Desktop** on the test playlist: remove, reorder, and rename through the
      page; restore the recorded state. LM Studio optional, as in phase 1.
- **Done when:**
  - in **Claude Desktop**, a plan opens the page; Approve shows a code; pasting it applies with
    `verified: true`;
  - a wrong code three times voids the confirmation;
  - Reject applies nothing;
  - the injection check holds;
  - the test playlist is back in its recorded state.

### Phase 3 (v3): data directory, demo, resources and prompts, authorization, MCP App, packaging

In this order; packaging comes last.

- [ ] **Data directory and configuration** (D5, D6, library items 1–2):
  - `CURATUNE_DATA_DIR`, the legacy guard, and `data migrate`;
  - the optional project root and the `.env` lookup;
  - from here on, development sets `CURATUNE_DATA_DIR` to a test directory.
  - Tests:
    - [ ] default dir plus legacy data → refuse;
    - [ ] explicit dir plus legacy data → warn;
    - [ ] `migrate` backs up, copies, verifies hashes, and refuses to overwrite;
    - [ ] a cwd equal to the home directory doesn't trip the token check;
    - [ ] `auth status` reports the legacy state.
  - Docs updated.
  - **Done when** these tests pass, and in a non-checkout install the server and CLI share one data dir
    that is never the cwd.
- [ ] **Demo mode:**
  - [ ] promote the fake to `curatune/demo.py`, with synthetic IDs and seed playlists that include a
        duplicate, a same-ISRC edition, and a shuffled order;
  - [ ] `curatune-mcp --demo` uses it, a temporary data dir, and no token;
  - [ ] `tests/fakes.py` re-exports it;
  - [ ] a test asserts no network call in demo mode.
  - **Done when** someone without a Spotify account installs the package and runs remove and reorder,
    including the confirmation, in Claude Desktop.
- [ ] **Resources and prompts** from section 4.
  - **Done when** an `@`-mentioned playlist works in Claude Code and the `deduplicate` prompt runs end to
    end in Claude Desktop.
- [ ] **`auth_login`:**
  - idempotent (a valid token, meaning a successful `access_token()` with all scopes, opens nothing);
  - the model receives only `{authorized: bool}`;
  - no `auth_logout` tool.
  - Tests: already authorized; expired → login; the token is never in a result.
- [ ] **MCP App plan viewer (gated):**
  - [ ] Build a minimal App with an app-only approval tool.
  - [ ] **Real test in Claude Desktop**, logged server-side:
    - (a) the model's tool list lacks the app-only tool (ask it to list its curatune tools);
    - (b) told explicitly to call it, the model cannot, and no such `tools/call` arrives from the model;
    - (c) a nonce shown only in the App is unknown to the model when asked.
  - [ ] **If any check fails, drop the App.** The page and code stay the Claude Desktop route, and this
        plan records the result.
  - [ ] If all pass, switch Claude Desktop's route to the App (section 5) and update the docs and the
        matrix.
- [ ] **Packaging (after the data directory):**
  - [ ] `uvx` and `pipx` instructions (from the GitHub repository, or from PyPI after phase 5), each with
        the config dir and `.env` for `SPOTIFY_CLIENT_ID`;
  - [ ] an `.mcpb` bundle using the `uv` server type (manifest 0.4, [mcpb-manifest]) with a `user_config`
        for the Client ID. **First verify empirically that Claude Desktop installs a `uv`-type bundle.**
        Traditional Python bundles can't ship compiled dependencies such as pydantic. If `uv` isn't
        supported, document the uvx configuration instead.
- **Done when** each item meets its own criterion, or is recorded as dropped with the evidence.

### Phase 4: portfolio

- [ ] README:
  - an architecture diagram (agent ↔ MCP client ↔ thin server ↔ library ↔ Spotify);
  - the decisions (D1–D11 condensed);
  - the confirmation model with diagrams;
  - prompt injection from third-party content;
  - the API facts verified live (from `AGENTS.md`);
  - the client matrix with sources;
  - why the server is not remote.
- [ ] `docs/mcp-demo-script.md`: a script for a 60–90 s video.
  1. Ask in Claude Code to remove a duplicate from the test or demo playlist; show the plan and the
     elicitation summary; accept; `verified`.
  2. Ask the same in Claude Desktop; the page (or the App) opens; approve; applied.
  3. Show a playlist description that tries to make the model apply a plan; nothing happens without the
     user.
  4. Demo mode for viewers without Spotify.
- **Done when** the user has reviewed both.

### Phase 5: cutover and publishing (each step only with the user's explicit OK)

- [ ] **Merges to `main`**: at any phase boundary, only with an OK.
- [ ] **Data cutover**, once phase 3's data directory is on `main`, with an OK and **no other curatune
      sessions open**:
  1. record `recordings show --brief` for each curated playlist listed in `AGENTS.local.md`;
  2. run `curatune data migrate` (backup, copy, hash check);
  3. run `recordings show --brief` again; the items must be identical;
  4. delete the legacy `data/` and `plans/` only with the OK.
- [ ] **PyPI (the last step):**
  - [ ] re-check the name, description, and any logo against [spotify-design];
  - [ ] the repository is public after a full audit for personal data and secrets, including history;
  - [ ] the user creates the PyPI account;
  - [ ] trusted publishing from GitHub Actions (OIDC), with no local tokens;
  - [ ] the user's explicit OK at the moment of publishing.

## 11. Verification

- Automated: run the full suite (both eras, with and without the extra) locally with
  `.venv/Scripts/python -m pytest` on Windows or `.venv/bin/python -m pytest`, and in CI. No test calls
  Spotify.
- Protocol level: run the MCP Inspector against `curatune-mcp` to see `tools/list` (annotations, schemas,
  instructions) and to step through an elicitation by hand.
- Real clients, on the test playlist only, following each phase's "done when":
  - Claude Code: `claude mcp add curatune -- <worktree venv>/curatune-mcp`;
  - Claude Desktop and LM Studio: an `mcpServers` entry pointing to the same executable.
- Before every commit: scan the staged files for personal data and secrets, including partial IDs.

## 12. After approval

1. Write `PLAN-mcp.md` and complete phase 0.
2. Stop there.
3. When the user says the rename is on `main`, sync and start phase 1.

Live writes go only to the test playlist. Nothing merges into `main` without an OK.

## Sources (accessed 2026-10-01)

- [versioning] https://modelcontextprotocol.io/specification/versioning
- [changelog] https://modelcontextprotocol.io/specification/2026-07-28/changelog
- [elicitation] https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- [mrtr] https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
- [tools] https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- [schema] https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts (`ToolAnnotations`)
- [security] https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
- [ext-matrix] https://modelcontextprotocol.io/extensions/client-matrix
- [pypi-mcp] https://pypi.org/project/mcp/ (2.2.0, 2026-09-07)
- [sdk-elicitation] https://py.sdk.modelcontextprotocol.io/handlers/elicitation/
- [sdk-dependencies] https://py.sdk.modelcontextprotocol.io/handlers/dependencies/
- [sdk-mrtr] https://py.sdk.modelcontextprotocol.io/handlers/multi-round-trip/
- [sdk-versions] https://py.sdk.modelcontextprotocol.io/protocol-versions/
- [sdk-testing] https://py.sdk.modelcontextprotocol.io/get-started/testing/
- [sdk-src] https://github.com/modelcontextprotocol/python-sdk/tree/v2.2.0 (`src/mcp/server/mcpserver/context.py`, `server.py`, `utilities/func_metadata.py`, `pyproject.toml`)
- [cc-mcp] https://code.claude.com/docs/en/mcp
- [cc-hooks] https://code.claude.com/docs/en/hooks#elicitation
- [cc-env] https://code.claude.com/docs/en/env-vars (`MCP_PROTOCOL_NEGOTIATION`)
- [claude-building] https://claude.com/docs/connectors/building
- [claude-review] https://claude.com/docs/connectors/building/review-criteria
- [claude-notes] https://support.claude.com/en/articles/12138966-release-notes
- [issue-41110] https://github.com/anthropics/claude-code/issues/41110
- [issue-1046] https://github.com/anthropics/claude-ai-mcp/issues/1046
- [lms-docs] https://lmstudio.ai/docs/app/mcp
- [lms-0317] https://lmstudio.ai/blog/lmstudio-v0.3.17
- [mcpb-manifest] https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
- [spotify-design] https://developer.spotify.com/documentation/design
