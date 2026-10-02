# curatune — a playlist toolkit for Spotify

Formerly spotikit. curatune is not affiliated with, endorsed by, or sponsored by Spotify. Spotify is a
trademark of Spotify AB.

Work with your own Spotify playlists by asking an AI agent in plain language. curatune is the deterministic
part: a Python library (`src/curatune`) plus a thin CLI that prints one JSON document per call, and an
optional local MCP server for MCP clients such as Claude Desktop. The judgment (what to add, what counts as
a duplicate, how to rank) comes from the agent, not from this code.

## What you can do

Ask in plain language. Some examples:

- **Create a playlist from a criterion.** "Create a playlist with the landmark recordings of early
  bebop." The agent picks the tracks and the right edition of each (original studio master, not a live
  version, cover, or karaoke), and says how confident it is about each choice.
- **Complete an existing playlist.** "Add 10 tracks to X that fit what's already there", or "add 15
  underrated Beatles songs: great tracks every fan loves but casual listeners don't know."
- **Reorder by a criterion.** "Sort X by recording date", "by release date", "by historical
  importance". You see the full before/after plan before anything moves.
- **Find duplicates and repeated versions.** The same recording on two editions (same ISRC), the same
  tune under another title, or an alternate/live take of a song already in the list.
- **Clean up.** "Remove the live versions from X", "drop everything recorded after 1960". Removals are
  shown as a plan; nothing is deleted until you approve it.
- **Switch editions.** "Use the newest remixes instead of the old remasters": the new versions are
  added, and removing the old ones goes through a plan.
- **Analyze.** "Rank X by influence", "which tracks have uncertain recording dates?", "is X in
  chronological order?", "which albums do these come from?"

Research such as recording dates (with source and confidence) is kept locally, so later additions and
reorders reuse it. You can also **rename a playlist or change its description** ("rename X to Y", "give X
a description"); the change is shown as a plan and applied after your OK. Some things are left out on
purpose, for safety; see [What curatune won't do](#what-curatune-wont-do).

## Using it with an AI agent

Open your agent in this repository and ask, as in the examples above. The agent learns the commands,
workflows, and safety rules from the project skill; on first use it walks you through setup, and you only
create the Spotify app, fill in `.env`, and approve the browser login.

| Agent | Reads |
|---|---|
| Claude Code | `CLAUDE.md` (imports `AGENTS.md`) and `.claude/skills/curatune/` (points to the shared skill) |
| Gemini CLI | `GEMINI.md` (imports `AGENTS.md`; Gemini CLI does not read `AGENTS.md` by default) and `.agents/skills/curatune/` |
| Codex CLI, Cursor, GitHub Copilot (VS Code), and other agents that support Agent Skills | `AGENTS.md` and `.agents/skills/curatune/` |

GitHub Copilot also scans `.claude/skills/`, so it lists two `curatune` skills. Either one works: the
`.claude/skills/` entry only points to the shared skill.

The skill uses the open [Agent Skills](https://agentskills.io) format. Agents that sandbox commands must
allow curatune network access to `accounts.spotify.com` and `api.spotify.com`, and let it write its token
outside the repository (see `CURATUNE_TOKEN_DIR` below). Personal preferences, such as your language or
per-playlist curation criteria, can go in a gitignored `AGENTS.local.md` at the repository root.

### Through MCP

Clients that speak the [Model Context Protocol](https://modelcontextprotocol.io), such as Claude Desktop,
Claude Code, or LM Studio, can use curatune without the repository's skill: install the `mcp` extra and add
`curatune-mcp` as a local server. Its tools carry the same rules. Removals, reorders, and renames are
plans there too, and a plan is applied only after you confirm it in a dialog your client shows: the AI
can't answer it for you. Clients without such dialogs open a local page instead, which shows the plan and,
if you approve, a one-time code you paste in the chat. Setup, tools, the
confirmation flow, and the differences from the CLI are in **[docs/mcp.md](docs/mcp.md)**. To try it without
a Spotify account, `curatune-mcp --demo` serves a synthetic account in memory, with no network and nothing
kept ([demo mode](docs/mcp.md#demo-mode)). Playlists and plans can also be attached as resources (an
`@`-mention in Claude Code), and the skill's workflows are prompts (`/mcp__curatune__deduplicate`, …).

## How changes stay safe

- Creating a playlist and adding tracks run directly.
- Removals, reorders, renames, and description changes are only ever built as **plans**: before, after,
  and the exact operations. The agent shows you the plan and applies it only after your OK. Through MCP,
  that OK is your answer in the client's confirmation dialog, which shows a summary built from the plan
  itself.
- Sorting by title, artist, album, release date, or duration is computed by curatune, not guessed by the
  agent.
- Applying a plan first checks that the playlist hasn't changed since the plan was made, backs it up to
  `backups/` in curatune's data directory, and verifies the result afterwards.
- Spotify currently makes every playlist created through the API **public**, whatever is requested.
  Make it private from the Spotify app if needed.

## What curatune won't do

### Left out on purpose

These are **deliberate protections, not gaps**. Spotify's API allows some of them; curatune leaves them
out so that a mistake, a misunderstood request, or text planted in a track or playlist name can't cause
damage that is hard to undo.

- **Delete a playlist.** The API can remove a playlist from your library, which is what "delete" does in
  the app. curatune has no command for it: a playlist only disappears if you delete it yourself in Spotify.
- **Change a playlist's visibility or make it collaborative.** Only the name and description can change.
  Visibility would decide who can see your playlist, and Spotify ignores it through the API anyway.
- **Touch anything outside your playlists:** your liked songs and saved albums, followed artists,
  playback, or listening history. curatune only requests the three playlist permissions, so it has no
  access to the rest.
- **Remove, reorder, rename, or change a description without your OK.** Every one of these goes through a
  plan you see first. There is no option to skip the confirmation.
- **Rewrite a playlist's whole track list in one go.** The API allows it, but it would reset the date each
  track was added. Reorders only move tracks.
- **Let an agent change Spotify without asking.** For agents that support pre-approval, only reading and
  building plans are pre-approved. Adding, creating, and applying a plan always go through the agent's
  normal approval, on top of your OK in the chat.
- **Send your access token anywhere but `api.spotify.com`, keep it in the repository, or use a client
  secret.**

If you need one of these, it can be added deliberately: open an issue or change the code, keeping the
plan-and-confirm flow.

### Limits set by Spotify

These are not choices, and no code change can lift them:

- Playlists created or edited through the API end up **public**. Make them private in the Spotify app.
- Only playlists you own or collaborate on can be read track by track or changed.
- There are no audio features, popularity, follower counts, or labels. The release date is the edition's
  date, not the recording date, so rankings and recording dates come from the agent's knowledge and
  sources.
- A search returns at most 10 results per request.
- Development Mode apps need a Premium account for the app owner and allow up to 5 users. The
  authorization lasts 6 months; after that you log in again.

## Setup

Requirements: Python 3.10 or newer, and a Spotify account with **Premium** for the app owner (a
Development Mode requirement). Development Mode apps allow up to 5 authorized users.

1. Create an app at <https://developer.spotify.com/dashboard> (Web API) and register the redirect URI
   `http://127.0.0.1:8888/callback` exactly. The dashboard rejects portless loopback URIs, so a new
   port also needs its own registered URI.
2. `cp .env.example .env` and set `SPOTIFY_CLIENT_ID`. No client secret is used (PKCE).
3. Install and authorize:

   ```bash
   python -m venv .venv
   .venv/Scripts/python -m pip install -e ".[dev]"   # .venv/bin/python on macOS/Linux
   .venv/Scripts/curatune auth login                  # .venv/bin/curatune on macOS/Linux
   ```

The token is stored outside the repository. Spotify refresh tokens expire 6 months after the original
authorization; after that, run `curatune auth login` again.

### Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | — (required) | App client ID. |
| `SPOTIFY_REDIRECT_PORT` | `8888` | Callback port; URI is always `http://127.0.0.1:<port>/callback` and must be registered in the dashboard. `auth login --port` overrides it. |
| `CURATUNE_MARKET` | none | Default market for `playlist show`, `search`, `track`, `album`. |
| `CURATUNE_TOKEN_DIR` | `%LOCALAPPDATA%\curatune` / `~/.config/curatune` | Token location (the config directory; a `.env` there is read too). Must be outside the repo (enforced). |
| `CURATUNE_DATA_DIR` | `%LOCALAPPDATA%\curatune\data` / `~/.local/share/curatune` | Plans, backups, the write log, and recording dates, shared by the CLI and the MCP server. Must be outside the repo (enforced). If curatune is first started by an app installed from the Microsoft Store (such as Claude Desktop), Windows can keep a new AppData folder private to that app; curatune refuses that (`DATA_DIR_VIRTUALIZED`): run it once from a terminal, or set this to a folder outside AppData. |

curatune used to keep its data in the repository's `data/` and `plans/`. If yours still has files there,
commands stop with `LEGACY_DATA_NOT_MIGRATED` until you run `curatune data migrate`, which backs them up,
copies them into the data directory, and checks every file; it never moves or deletes the originals.

## Commands

| Command | Does |
|---|---|
| `auth login` / `status` / `logout` | Authorize, inspect, or remove the stored token. |
| `data migrate` | Copy data left in the repository's `data/` and `plans/` into the data directory. |
| `playlists list` | Your playlists. |
| `playlist show` | A playlist and all its items. |
| `playlist create` / `playlist add` | Create a playlist; add tracks (runs directly). |
| `search tracks` | Catalog search, single or batch. |
| `track show` / `album tracks` | One track (with ISRC); an album's full listing. |
| `recordings show` / `recordings set` | Read and store researched recording dates. |
| `plan remove` / `plan reorder` / `plan details` | Build a plan to remove, reorder, or rename / change the description (changes nothing on Spotify). |
| `plan show` / `plan apply` | Inspect a plan; apply it after approval. |

Arguments, JSON output shapes, error and warning codes, the plan format, and the Spotify API quirks
curatune works around are in **[docs/reference.md](docs/reference.md)**.

## Development

```
src/curatune/
  auth.py        OAuth PKCE flow, token storage outside the repo, refresh/expiry handling
  http.py        Web API client: retries (429/5xx/network), 401 refresh, error mapping, pagination
  playlists.py   list, read (consistent snapshot), create, add
  catalog.py     search (single and concurrent batch), track, album listing
  plans.py       remove/reorder plans: build, validate, apply, verify
  _writes.py     mutating primitives (private: only plans and add use them)
  recordings.py  local recording-date store and chronological ordering
  writelog.py    compensation for snapshot_id read lag
  config.py      settings, the config and data directories, .env lookup
  datadir.py     the guard against data left in a checkout, and `data migrate`
  models.py      normalization to the documented JSON shapes (full and brief)
  metrics.py     per-command HTTP timing
  cli.py         thin argparse layer emitting the JSON envelope
  mcp_server/    thin MCP server (stdio) over the same library; optional extra `curatune[mcp]`
.agents/skills/curatune/SKILL.md   how an AI agent uses curatune (shared skill)
docs/reference.md                  CLI contract and API notes
docs/mcp.md                        MCP server: setup, tools, differences from the CLI
```

```bash
.venv/Scripts/python -m pip install -e ".[dev,mcp]"   # .venv/bin/python on macOS/Linux
.venv/Scripts/python -m pytest
```

Plan logic runs against an in-memory fake of the playlist API (including snapshot read lag), the HTTP
client against a scripted session, the OAuth callback against a real local server, and the MCP server
through an in-memory MCP client in both protocol eras (skipped without the `mcp` extra). No test calls
Spotify. CI runs the suite on Windows and Linux, with and without the extra.
