# spotikit

Work with your own Spotify playlists by asking an AI agent in plain language. spotikit is the deterministic
part: a Python library (`src/spotikit`) plus a thin CLI that prints one JSON document per call. The
judgment (what to add, what counts as a duplicate, how to rank) comes from the agent, not from this code.

## What you can do

Ask in plain language. Some examples:

- **Create a playlist from a criterion.** "Create a playlist with the landmark recordings of early
  bebop." Claude picks the tracks and the right edition of each (original studio master, not a live
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
reorders reuse it. Out of scope: playback, your library and liked songs, listening history, and changing
a playlist's name, description, or visibility.

## Using it with Claude Code

Open Claude Code in this repository and ask, as in the examples above. The project skill in
`.claude/skills/spotikit/` teaches Claude the commands, the workflows, and the safety rules. On first
use, Claude walks you through setup: you only create the Spotify app, fill in `.env`, and approve the
browser login.

## How changes stay safe

- Creating a playlist and adding tracks run directly.
- Removals and reorders are only ever built as **plans**: before, after, and the exact operations. Claude
  shows you the plan and applies it only after your OK.
- Applying a plan first checks that the playlist hasn't changed since the plan was made, backs it up to
  `data/backups/`, and verifies the result afterwards.
- There is no command to rename a playlist or change its description or visibility.
- Spotify currently makes every playlist created through the API **public**, whatever is requested.
  Make it private from the Spotify app if needed.

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
   .venv/Scripts/spotikit auth login                  # .venv/bin/spotikit on macOS/Linux
   ```

The token is stored outside the repository. Spotify refresh tokens expire 6 months after the original
authorization; after that, run `spotikit auth login` again.

### Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | — (required) | App client ID. |
| `SPOTIFY_REDIRECT_PORT` | `8888` | Callback port; URI is always `http://127.0.0.1:<port>/callback` and must be registered in the dashboard. `auth login --port` overrides it. |
| `SPOTIKIT_MARKET` | none | Default market for `playlist show`, `search`, `track`, `album`. |
| `SPOTIKIT_TOKEN_DIR` | `%LOCALAPPDATA%\spotikit` / `~/.config/spotikit` | Token location. Must be outside the repo (enforced). |

## Commands

| Command | Does |
|---|---|
| `auth login` / `status` / `logout` | Authorize, inspect, or remove the stored token. |
| `playlists list` | Your playlists. |
| `playlist show` | A playlist and all its items. |
| `playlist create` / `playlist add` | Create a playlist; add tracks (runs directly). |
| `search tracks` | Catalog search, single or batch. |
| `track show` / `album tracks` | One track (with ISRC); an album's full listing. |
| `recordings show` / `recordings set` | Read and store researched recording dates. |
| `plan remove` / `plan reorder` | Build a plan (changes nothing on Spotify). |
| `plan show` / `plan apply` | Inspect a plan; apply it after approval. |

Arguments, JSON output shapes, error and warning codes, the plan format, and the Spotify API quirks
spotikit works around are in **[docs/reference.md](docs/reference.md)**.

## Development

```
src/spotikit/
  auth.py        OAuth PKCE flow, token storage outside the repo, refresh/expiry handling
  http.py        Web API client: retries (429/5xx/network), 401 refresh, error mapping, pagination
  playlists.py   list, read (consistent snapshot), create, add
  catalog.py     search (single and concurrent batch), track, album listing
  plans.py       remove/reorder plans: build, validate, apply, verify
  _writes.py     mutating primitives (private: only plans and add use them)
  recordings.py  local recording-date store and chronological ordering
  writelog.py    compensation for snapshot_id read lag
  models.py      normalization to the documented JSON shapes (full and brief)
  metrics.py     per-command HTTP timing
  cli.py         thin argparse layer emitting the JSON envelope
.claude/skills/spotikit/SKILL.md   how an AI agent uses spotikit
docs/reference.md                  CLI contract and API notes
```

```bash
.venv/Scripts/python -m pytest   # .venv/bin/python on macOS/Linux
```

Plan logic runs against an in-memory fake of the playlist API (including snapshot read lag), the HTTP
client against a scripted session, and the OAuth callback against a real local server. No test calls
Spotify.
