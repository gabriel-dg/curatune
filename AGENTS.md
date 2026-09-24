# spotikit — Spotify Playlist Toolkit

## Goal

A Python toolkit for working with the user's own Spotify playlists through the Spotify Web API. The user
asks an AI agent in natural language ("add 10 landmark bebop tracks", "reorder by recording date", "find
duplicates"), and the agent fulfils it with spotikit. Scope: **playlists only** (create, read, edit, analyze);
no playback, library, or listening history.

**Using spotikit** (commands, workflows, rules, error handling) is covered by the project skill
`.agents/skills/spotikit/SKILL.md`, which loads when a request is about the user's playlists. This file
covers **developing** spotikit.

Personal context (conversation language, reference playlists, curation criteria) lives in the gitignored
`AGENTS.local.md` at the repository root; read it when present. Never put personal data (user IDs, playlist IDs, names, emails, local paths) in
versioned files.

## Agent files

The repository works with any agent that reads `AGENTS.md` and Agent Skills (`SKILL.md`), such as Codex,
Cursor, Gemini CLI, and GitHub Copilot, as well as Claude Code. Keep a single source for each:

- `AGENTS.md` (this file) holds the development instructions. `CLAUDE.md` and `GEMINI.md` only import it
  and `AGENTS.local.md`; put nothing else there.
  - Gemini CLI reads `GEMINI.md`, not `AGENTS.md`, by default.
  - Claude Code reads `AGENTS.md` natively since v2.1.277, but only when there is no `CLAUDE.md`, and some
    sessions can't (older versions, some sessions right after an upgrade). It never reads `AGENTS.local.md`.
    Keep `CLAUDE.md` as the import: it covers those sessions, loads the personal file, and never makes
    `AGENTS.md` load twice.
- `.agents/skills/spotikit/SKILL.md` is the skill. Claude Code only discovers `.claude/skills/`, so
  `.claude/skills/spotikit/SKILL.md` is a thin entry point that points to it and pre-approves the read-only
  commands (`allowed-tools`). Its `name` and `description` must match the shared skill
  (`tests/test_agent_files.py`).
- Keep agent-neutral wording in shared files: "the agent", not a product name.

## Division of responsibilities

- **Execution layer (this code):** deterministic operations against the API. Input via arguments, output
  as stable, documented JSON (see `docs/reference.md`). No judgment or curation logic in the code.
- **Judgment layer (the agent):** interprets requests, combines commands, applies domain knowledge (and web
  search), explains decisions and confidence.

Architecture: library package `src/spotikit/` with all logic; thin CLI (`cli.py`) on top. Keep the library
usable on its own so it can be wrapped as an MCP server later without rewriting anything. Any new CLI
command must be documented in `docs/reference.md` (and listed in README.md) and in the skill.

## Confirmation rules (enforced in code — keep them that way)

- Create playlist / add items: executed directly.
- Remove / reorder: only through **plans** (`plans.py`). A plan records the current state, the change, the
  resulting state, and the exact operations; `plan apply` verifies snapshot + item list before running
  and verifies the result after. Mutating primitives live in `_writes.py` and are only called by
  `plans.apply_plan` (and `playlists.add_items` for inserts).
- Before applying any plan, the user must see it and give an explicit OK (per plan).
- There is deliberately **no** operation to change a playlist's name, description, or visibility.
- Never bypass these rules with ad-hoc scripts or private functions that mutate Spotify.

## Secrets and authorization

- OAuth Authorization Code **with PKCE**; no client secret. The Client ID lives only in `.env` (the user
  fills it in; never ask for credentials in chat). Never print or log credentials or tokens.
- `state` is validated on the callback. The token is stored **outside the repo** (default
  `%LOCALAPPDATA%\spotikit\token.json` or `~/.config/spotikit/token.json`; `SPOTIKIT_TOKEN_DIR` overrides;
  a path inside the repo is rejected).
- Callback port: `SPOTIFY_REDIRECT_PORT` (default 8888) or `auth login --port`; the exact
  `http://127.0.0.1:<port>/callback` must be registered in the dashboard (portless URIs are rejected).
- Gitignored: `.env`, `plans/`, `data/` (backups, write log, recordings), `AGENTS.local.md`.
- Before every commit, scan the files to be committed for personal data and secrets (including partial
  IDs). The repo is intended to be published.

## Data limitations

- No audio features; since the 2026 migration no `popularity`, `followers`, `label`, or
  `available_markets`. Rankings and criteria depend on knowledge or external sources.
- `release_date` is the **edition** date, not the recording date. Recording dates live in
  `data/recordings.json` (`recordings.py`), with source and confidence.
- ISRC (`external_ids`, restored March 2026) helps match the same recording across editions (not fully
  reliable across remasters).

## Spotify Web API facts (verified September 2026)

- Development Mode: app owner needs Premium; max 5 users per app; 1 client ID per developer; quota shared
  per developer account.
- Playlist items: `/playlists/{id}/items` (GET/POST/PUT/DELETE); old `/tracks` endpoints return 403. In
  responses `tracks` → `items`, `track` → `item`. Items are only returned for playlists the user owns or
  collaborates on. `GET …/items` limit max 50.
- Verified live (2026-09-23): reads with and without a market returned identical URIs (no relinking); ISRC
  present on items; `is_playable` only with a market. Plans always read without a market.
- Create playlist: `POST /me/playlists`. **Visibility cannot be set to private through the API**: create
  ignores `public: false` while echoing it back, and `PUT /playlists/{id}` with `public: false` returns
  200 without effect (confirmed in the app too). `create_playlist` re-reads and reports real visibility.
- Batch fetch endpoints (`GET /tracks?ids=` etc.) were removed; only single-item fetches remain.
- `GET /search`: max `limit` 10; paginate with `offset`. Batch search runs ≤4 requests concurrently.
- `DELETE …/items` takes URIs only and removes **every** occurrence of a URI (verified live); plans
  re-insert kept occurrences.
- **snapshot_id read lag** (observed live): after a write, reads return the previous `snapshot_id` for a
  few minutes while items are already current; the write's snapshot is what reads converge to. Handled
  by `writelog.py` (`data/write_log.json`, `SNAPSHOT_READ_LAG`).
- `snapshot_id` is not a lock: Spotify applies changes even on a stale snapshot; `plan apply` checks itself.
- `PUT …/items` either replaces (max 100, loses `added_at`) or moves a range; spotikit only uses moves.
- Refresh tokens expire 6 months after the original authorization (not extended by refreshing); on
  `invalid_grant` the token is discarded and `AUTH_EXPIRED` is raised.
- Scopes: `playlist-read-private`, `playlist-modify-public`, `playlist-modify-private`.

## Development

- Everything in the repository (code, comments, identifiers, docs, commit messages) is in **English**.
- The package is installed in editable mode: other sessions using spotikit run this working tree
  **live**. A half-finished edit breaks their commands (seen 2026-09-24: `NameError` in `cli.py` mid-edit).
  When another session may be using spotikit, develop in a separate git worktree, or make every save
  leave the package importable (define helpers before the code that calls them).
- Positions in JSON are **0-based** (same as the API).
- Tests: `.venv/Scripts/python -m pytest` (Windows) or `.venv/bin/python -m pytest`. Plan logic is tested
  against an in-memory fake of the playlist API (`tests/fakes.py`); HTTP behaviour against a scripted
  session (`tests/test_http.py`).
