# Spotify Playlist Toolkit

## Goal

A Python toolkit for working with the user's own Spotify playlists through the Spotify Web API.
Claude Code uses it to fulfil natural-language requests such as:

- "Create a playlist with the landmark recordings of <genre/era>."
- "Check whether <playlist> has duplicates or repeated versions of the same tune."
- "Add 10 tracks that complete the playlist according to <criterion>."
- "Rank this playlist's tracks by historical importance."
- "Reorder the playlist by recording date."

Scope: **playlists only** (create, read, edit, analyze). No playback, library, or listening history.

Personal context (conversation language, reference playlists, curation criteria) lives in the
gitignored `CLAUDE.local.md`, which Claude Code loads after this file. Never put personal data
(user IDs, playlist IDs, names, emails, local paths) in versioned files.

## Language

- Everything in the repository (code, comments, identifiers, docs, commit messages) is in **English**.

## Division of responsibilities

- **Execution layer (this code):** deterministic operations against the API. Input via arguments,
  output as stable, documented JSON. No judgment or curation logic in the scripts.
- **Judgment layer (Claude):** interprets the request, combines commands, applies domain knowledge
  (and web search when needed), and explains every decision to the user.

Architecture: a library package with all API logic, and a thin CLI on top. The library must stay
usable on its own so it can later be wrapped as an MCP server without rewriting anything.

## Confirmation rules (enforced in code, not only by behavior)

- **Create playlist / add items:** executed directly.
- **Remove / reorder:** by default only generate a **plan** (JSON file with current state, proposed
  change, and resulting state). Nothing is sent to Spotify.
- A plan is applied **only** through the explicit apply command, which verifies that the playlist
  has not changed since the plan was generated (snapshot_id + item list). If it changed, it aborts.
- **Before applying any plan, always show it to the user and wait for an explicit OK.** Approval is
  per plan; it never carries over to another plan.
- **Never** modify the name, description, or visibility of an existing playlist unless the user
  explicitly asks for it. The library does not expose that operation.
- Never bypass these rules by writing ad-hoc scripts or calling low-level/private library functions
  that mutate Spotify. All removals and reorders go through plans.

## Secrets and authorization

- Authorization is OAuth Authorization Code **with PKCE**: no Client Secret is used or read. The Client ID
  lives **only** in `.env` (loaded manually by the user; never ask for credentials in chat). Never print
  or log credentials or tokens, or write them to versioned files.
- `state` is validated on the callback. The token is stored **outside the repo** (default
  `%LOCALAPPDATA%\spotikit\token.json`; `SPOTIKIT_TOKEN_DIR` overrides, and a path inside the repo is rejected).
- Callback port: `SPOTIFY_REDIRECT_PORT` (default 8888) or `auth login --port`. Registered in the
  dashboard: `http://127.0.0.1:8888/callback`. The dashboard rejects portless URIs, so a new port
  needs its URI registered first.
- If a command fails with `AUTH_EXPIRED` or `AUTH_REQUIRED`, tell the user to run `spotikit auth login`
  (it opens a browser; the user completes it). Do not try to work around it.
- `.env`, `plans/`, and `data/` are gitignored.

## Data limitations (assume these always)

- Spotify no longer provides audio features (tempo, energy, etc.), and since the 2026 migration it no
  longer returns `popularity`, `followers`, `label`, or `available_markets`. Any ranking or criterion
  depends on Claude's knowledge or external sources, not on Spotify data.
- **When there is no reliable information, say so instead of inventing it.** Mark confidence explicitly.
- Spotify's `release_date` is the date of the **edition** (album/compilation), not the recording date.
  Recording dates must come from discographies/external sources and are stored locally
  (see `data/recordings.json`, once implemented) with source and confidence.
- `external_ids` (ISRC) was restored in March 2026 and is useful to detect the same recording across
  editions (not fully reliable across remasters).

## Spotify Web API facts (verified against official docs, September 2026)

- Development Mode: app owner needs Premium; max 5 users per app; 1 client ID per developer; quota
  shared per developer account.
- Playlist item endpoints are `/playlists/{id}/items` (GET/POST/PUT/DELETE); the old `/tracks`
  endpoints return 403. In responses, `tracks` → `items` and `track` → `item`.
- Playlist items are only returned for playlists the user **owns or collaborates on**.
- Verified live (2026-09-23, 41-track playlist): reading with and without a market returned identical
  URIs (no relinking), ISRC present on every item, `is_playable` populated only with a market.
- Create playlist: `POST /me/playlists` (`/users/{id}/playlists` was removed).
- Batch fetch endpoints (`GET /tracks?ids=`, `GET /albums?ids=`, ...) were removed; only single-item
  fetches remain.
- `GET /search`: max `limit` 10 (default 5); paginate with `offset`.
- `DELETE /playlists/{id}/items` takes URIs only (no positions) and removes **every** occurrence of a
  URI (verified live 2026-09-23). Plans re-insert kept occurrences; their `added_at` resets.
- **Read lag on snapshot_id** (observed 2026-09-23): after a write, `GET /playlists/{id}` keeps returning
  the previous `snapshot_id` for a few minutes, while the item list is already up to date. The
  snapshot returned by the write is the one reads eventually converge to. spotikit compensates via
  `data/write_log.json` (see README, "Snapshot read lag"); `SNAPSHOT_READ_LAG` warnings are expected
  right after writes and are not a problem. Verified live: add → immediate reorder plan → apply works.
- `snapshot_id` is **not** a lock:
  Spotify applies changes even if the playlist changed since that snapshot. Our apply command does its
  own check.
- `PUT /playlists/{id}/items` either replaces (max 100 URIs, loses `added_at`) or reorders a range
  (`range_start`, `insert_before`, `range_length`). Prefer reorder moves.
- Refresh tokens expire 6 months after the original authorization (refreshing does not extend it).
  On `invalid_grant`, discard the token and re-run the login flow.
- Redirect URI must use `http://127.0.0.1:<port>/callback` (`localhost` is not allowed).
- Scopes: `playlist-read-private`, `playlist-modify-public`, `playlist-modify-private`.

## Conventions

- Positions in JSON are **0-based** (same as the API). When talking to the user, use 1-based numbering
  and say so if there is any room for confusion.

## Curation judgment

Curation criteria are per playlist and come from the user (see `CLAUDE.local.md` when present).
Typical judgment calls: telling a composition apart from a specific recording (same melody under
another title, contrafacts), master vs alternate takes, original vs re-recordings, preferred editions.
Use durations, album names, labels, and ISRC as signals, and state confidence for every call.

## Command reference

Run from the project root with `.venv/Scripts/spotikit` (or `.venv/Scripts/python -m spotikit`).
Full JSON shapes, plan format, and error codes: [README.md](README.md). Every call prints one JSON envelope:
`{"schema_version":1,"ok":true,"command":…,"data":…,"warnings":[…]}` or `{"ok":false,"error":{"code","message","details"}}`.
Refs accept a bare ID, `spotify:` URI, or `open.spotify.com` URL. Positions are 0-based.

| Command | Effect |
|---|---|
| `auth login [--port N] [--no-browser]` / `auth status` / `auth logout` | Authorization (user-driven). |
| `playlists list [--owned-only]` | List the user's playlists. |
| `playlist show <playlist> [--market CC]` | Metadata + all items (position, name, artists, album, duration, ISRC, URI, added_at). |
| `playlist create --name N [--description D] [--public] [--allow-duplicate-name]` | **Executes.** Private by default. |
| `playlist add <playlist> [refs…] [--from-file F] [--position N] [--allow-duplicates]` | **Executes.** Skips URIs already present unless told otherwise. |
| `search tracks [q] [--track --artist --album --year] [--limit ≤10] [--offset N] [--market CC]` | Candidates. `--year` is the edition's release year. |
| `track show <track>` | One track, with ISRC. |
| `album tracks <album>` | Album listing (e.g. to find the master take inside a preferred edition). No ISRC. |
| `plan remove <playlist> --positions "3,17,20-22" [--reason R]` | **Plan only**, writes `plans/<plan_id>.json`. |
| `plan reorder <playlist> (--order "…" \| --order-file F \| --move FROM:TO) [--reason R]` | **Plan only.** `--order` is a permutation of current positions. |
| `plan show <plan> [--check]` | Show and validate a plan; `--check` compares it with the live playlist. |
| `plan apply <plan>` | **Only after the user's explicit OK for that plan.** Checks snapshot + items, backs up, applies, verifies. |

Workflow for remove/reorder: build the plan → `plan show` → present it to the user in chat (1-based
numbering, what moves/leaves and why) → wait for explicit OK → `plan apply`. If apply returns
`SNAPSHOT_MISMATCH`, regenerate the plan and ask again.
