# curatune MCP server

`curatune-mcp` is a local [Model Context Protocol](https://modelcontextprotocol.io) server (stdio) over the
same library the CLI uses. MCP clients such as Claude Code, Claude Desktop, or LM Studio can work with your
playlists through it, with no repository-specific skill: the tool descriptions and the server's
instructions carry the rules. For the design and its decisions, see [PLAN-mcp.md](../PLAN-mcp.md).

This version (phase 1) reads playlists and the catalog, creates playlists, adds tracks, and keeps
recording dates. **Removals, reorders, and renames are not exposed yet**: they come with plans and a human
confirmation the model cannot skip. Until then, use the CLI and its skill for those.

## Install and connect

The server is an optional extra; the library and the CLI never need it.

```bash
.venv/Scripts/python -m pip install -e ".[mcp]"   # .venv/bin/python on macOS/Linux
```

Set up and authorize as in the [README](../README.md#setup) first (`.env` with `SPOTIFY_CLIENT_ID`, then
`curatune auth login`). Running from the repository's `.venv`, the server reads that same `.env` and token,
whatever directory the client starts it in.

| Client | Configuration |
|---|---|
| Claude Code | `claude mcp add curatune -- <repo>/.venv/Scripts/curatune-mcp.exe` (`<repo>/.venv/bin/curatune-mcp` on macOS/Linux) |
| Claude Desktop | Settings → Developer → Edit Config, then add `"curatune": {"command": "<repo>/.venv/Scripts/curatune-mcp.exe"}` under `mcpServers` |
| LM Studio (0.3.17+) | Program tab → Install → Edit `mcp.json`, same `mcpServers` entry as Claude Desktop |

A stdio server runs on the same machine as its client. To use LM Studio on another computer, install and
authorize curatune there too (its own `.env`, token, and data); a Development Mode app allows it, since it
is the same Spotify user.

Logs go to stderr, which clients keep in their MCP logs (Claude Desktop keeps one log file per server). On the
first call from each kind of client, the server logs the protocol version, the client's name and version,
and the capabilities it declares, with no personal data. That records what each client really supports.

## Tools

RO = read-only; D = destructive; I = idempotent; OW = talks to Spotify. Every result is structured content
with a declared output schema, plus the same JSON as text.

| Tool | Does | RO | D | I | OW |
|---|---|---|---|---|---|
| `auth_status` | Whether curatune is authorized, and if not why (`CONFIG_ERROR`, `AUTH_REQUIRED`, `AUTH_EXPIRED`, `MISSING_SCOPES`). Reads the token file only: no token, no user ID. | ✓ | | | |
| `playlists_list` | The user's playlists: id, name, owner, item count. `owned_only` filters. | ✓ | | | ✓ |
| `playlist_show` | A playlist and its tracks, numbered from 1, up to `limit` (≤100) per call from `start`; continue with `next_start`. `full` returns full track objects. | ✓ | | | ✓ |
| `search_tracks` | One catalog search (≤10 results, `offset` to page), free text and/or `track`, `artist`, `album`, `year` filters. | ✓ | | | ✓ |
| `search_many` | Up to 25 searches at once (4 concurrent), each with `limit` ≤10 (default 5); one failure doesn't fail the rest. | ✓ | | | ✓ |
| `track_show` | One track in full, with its ISRC. | ✓ | | | ✓ |
| `album_tracks` | An album's full listing (no ISRCs; `track_show` has them). | ✓ | | | ✓ |
| `recordings_show` | A playlist joined with the stored recording dates: `missing` and `chronological`. | ✓ | | | ✓ |
| `recordings_set` | Store recording dates. **Additive only**: tracks that already have a date are listed in `skipped` and left alone. | | | ✓ | |
| `recordings_update` | Replace stored recording dates. Only when the user asks to correct one. | | ✓ | ✓ | |
| `playlist_create` | Create an empty playlist. There is no visibility option: curatune always requests private, Spotify makes it public, and the result says so. | | | | ✓ |
| `playlist_add` | Add tracks (≤100 per call), appended or at `at_number`; already-present tracks are skipped unless `allow_duplicates`. Reads the playlist back: names each added track and reports `verified`. | | | | ✓ |

Why recording dates are two tools: `destructiveHint` describes the worst a tool can do with any
arguments. One tool with an `overwrite` flag would have to be marked destructive, so clients that prompt
for destructive tools (Claude Desktop always does) would prompt for every additive call too. Two tools give
each one accurate hints, and protect hand-curated dates in code rather than in a prompt.

## Conventions

- **Track numbers are 1-based.** Playlist items carry `number` (1 = first track, as in the Spotify app),
  and tools take numbers (`start`, `at_number`). Warnings and error details that refer to items use
  `number`/`numbers` too. The CLI and [reference.md](reference.md) keep 0-based positions; the conversion
  happens in one module, `mcp_server/numbering.py`.
- **Compact by default.** Tracks come as `{number, uri, name, artists, album, released, duration, isrc,
  playable}`; `full: true` returns the full shapes of [reference.md](reference.md#shared-shapes), with
  `number` instead of `position`.
- **Errors** are tool results with `isError: true` and the text
  `{"error": {"code", "message", "details"}, "next_step": "…"}`. The codes are the CLI's
  ([reference.md](reference.md#error-codes)); `next_step`, when present, says what to do next (for example,
  ask the user to run `curatune auth login`).
- **Warnings** are the CLI's, inside each result's `warnings`.
- **Third-party text.** Names and descriptions of playlists, tracks, albums, and artists are written by
  other people. Tool descriptions and server instructions tell the model to treat them as data.

## Deliberate differences from the CLI

| CLI | MCP server | Why |
|---|---|---|
| 0-based `position` | 1-based `number` | Small models read 0-based positions as track numbers (spotikit-web's evaluation), and every model talks to the user in 1-based numbers anyway. |
| `playlist create --public` | No visibility option | Visibility is never the model's choice; Spotify ignores it anyway. |
| `--from-file` inputs | JSON arguments only, never a path | A path argument could send a local file's contents to Spotify as search queries. |
| `recordings set` overwrites | `recordings_set` (additive) and `recordings_update` | Accurate annotations, and curated dates protected in code. |
| `playlist show` returns every item | Pages of up to 100 | Client limits on tool results (Claude Code: 25,000 tokens by default). |
| Batch search up to 50, 10 results each | `search_many` up to 25, 5 each by default | The same budget. |
| `meta` timing in every envelope | Not returned; logged to stderr | `metrics` is per process, and the server runs concurrent calls. |
| `--market` per command | `CURATUNE_MARKET` from `.env` | Fewer arguments to get wrong. |

Unknown top-level arguments are ignored (the SDK's behaviour); unknown keys inside `searches` or `entries`
are rejected.

## Development

```
src/curatune/mcp_server/
  __init__.py      main(): the curatune-mcp entry point; explains how to install the extra if missing
  server.py        runtime (settings, tokens, a client per call, write lock), result envelopes, next_step, probe
  tools.py         tool registrations: validate → numbers → library (in a worker thread) → view
  views.py         what the model sees: compact views of the library's results
  numbering.py     the only 0-based ↔ 1-based conversion
  schemas.py       nested inputs and every tool's (strict) output model
  instructions.py  the server instructions
```

- `tests/test_mcp_server.py` drives the server through an in-memory MCP client in **both protocol eras**
  (the 2025-11-25 handshake and 2026-07-28) against `tests/fakes.py:FakeAccount`. It is skipped when the
  extra isn't installed.
- `tests/test_mcp_numbering.py` covers the conversion; `tests/test_mcp_invariants.py` checks that the
  server never imports `_writes` or `requests`, and that the library and the CLI never import `mcp`.
- CI (`.github/workflows/tests.yml`) runs the suite on Windows and Linux, Python 3.10 and 3.14, with and
  without the extra.
