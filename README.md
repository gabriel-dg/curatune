# spotikit

Deterministic toolkit for Spotify playlists: a Python library (`src/spotikit`) plus a thin CLI.
Every CLI call prints exactly one JSON document to stdout. Judgment (what to add, what counts as
a duplicate, how to rank) is intentionally **not** in this code.

## Using it with Claude Code

spotikit is meant to be driven by an AI agent. Open Claude Code in this repository and ask in natural
language, for example "add 10 landmark bebop recordings to my playlist X", "check playlist Y for
duplicate versions", or "reorder it by recording date". The project skill in
`.claude/skills/spotikit/` teaches Claude the commands, the workflows, and the safety rules:
removals and reorders are shown to you as plans and applied only after your OK. On first use, Claude
walks you through setup. You only create the Spotify app, fill in `.env`, and approve the browser login.

## Setup

1. Create an app at <https://developer.spotify.com/dashboard> (Web API) and register the redirect URI
   `http://127.0.0.1:8888/callback` exactly. The dashboard rejects portless loopback URIs, so a new
   port also needs its own registered URI.
2. `cp .env.example .env` and set `SPOTIFY_CLIENT_ID`. No client secret is used (PKCE).
3. Install and authorize:

   ```bash
   python -m venv .venv
   .venv/Scripts/python -m pip install -e ".[dev]"   # .venv/bin/python on macOS/Linux
   .venv/Scripts/spotikit auth login
   ```

### Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | — (required) | App client ID. |
| `SPOTIFY_REDIRECT_PORT` | `8888` | Callback port; URI is always `http://127.0.0.1:<port>/callback` and must be registered in the dashboard. `auth login --port` overrides it. |
| `SPOTIKIT_MARKET` | none | Default market for `playlist show`, `search`, `track`, `album`. |
| `SPOTIKIT_TOKEN_DIR` | `%LOCALAPPDATA%\spotikit` / `~/.config/spotikit` | Token location. Must be outside the repo (enforced). |

### Authorization

OAuth 2.0 Authorization Code with PKCE (S256). `state` is random per login and validated (constant-time)
before any other callback parameter is used. The token file lives outside the repository. Spotify refresh
tokens expire 6 months after the original authorization; refreshing does not extend that. When Spotify
answers `invalid_grant`, the stored token is deleted and commands fail with `AUTH_EXPIRED`: run
`spotikit auth login` again. `auth status` shows the estimated expiry.

## Output contract

```jsonc
// success (exit 0)
{"schema_version": 1, "ok": true, "command": "playlist show", "data": { ... }, "warnings": [ ... ]}
// failure (exit 1 = spotikit error, 2 = usage, 3 = internal, 130 = interrupted)
{"schema_version": 1, "ok": false, "command": "plan apply", "error": {"code": "SNAPSHOT_MISMATCH", "message": "...", "details": { ... }}}
```

Warnings are objects `{"code", "message", ...}`. **Positions are 0-based everywhere.**

Every envelope (success or failure) also carries timing:

```json
"meta": {"elapsed_ms": 812.4, "http": {"api": {"calls": 4, "ms": 690.2}, "auth": {"calls": 1, "ms": 95.0}}}
```

`elapsed_ms` is the command's own time (interpreter start-up and imports excluded); `http.api` counts
Spotify Web API requests (retries included), `http.auth` token exchanges/refreshes.

### Shared shapes

**Track** (search, `track show`, `album tracks`); every key is always present, `null` when unknown:

```json
{
  "uri": "spotify:track:…", "id": "…", "type": "track", "name": "Ko-Ko",
  "artists": [{"name": "Charlie Parker", "uri": "spotify:artist:…"}],
  "album": {"name": "…", "uri": "…", "album_type": "compilation",
            "release_date": "2002", "release_date_precision": "year", "artists": [ … ]},
  "duration_ms": 174000, "duration": "2:54", "disc_number": 1, "track_number": 12,
  "isrc": "…", "explicit": false, "is_local": false, "is_playable": null, "url": "https://open.spotify.com/track/…"
}
```

- `release_date` is the **edition's** date, not the recording date.
- `isrc` is `null` in `album tracks` (simplified objects); use `track show` to get it.
- `is_playable` is only set when a market is given.

**PlaylistItem** = `{"position": 0, ...Track, "added_at": "…"}`. Unavailable items have `uri: null`.

**Brief track** (`--brief` on `playlist show`, `search tracks`, `album tracks`): a flat, compact view,
about a third of the size, with every key always present:
`{"position" (playlist items only), "uri", "name", "artists": ["name", …], "album": "name", "released", "duration", "isrc", "playable"}`.
`recordings show --brief` items are `{"position", "uri", "name", "artists", "recorded", "confidence"}`.

**Playlist**:
`{"id", "uri", "name", "description", "owner_id", "owner_name", "owned", "collaborative", "public", "item_count", "snapshot_id", "url"}`

## Commands

| Command | `data` |
|---|---|
| `auth login [--port N] [--no-browser] [--timeout S]` | same as `auth status` |
| `auth status` | `{logged_in, user_id, display_name, client_id_matches, scopes, missing_scopes, authorized_at, refresh_expires_approx, refresh_likely_expired, access_token_expires_at, token_path}` |
| `auth logout` | `{logged_out, token_path}` |
| `playlists list [--owned-only]` | `{user_id, count, playlists: [Playlist]}` |
| `playlist show <playlist> [--market CC]` | `{playlist: Playlist, items: [PlaylistItem]}` + warnings `LOCAL_FILES`, `UNAVAILABLE_ITEMS`, `SNAPSHOT_READ_LAG` |
| `playlist create --name N [--description D] [--public] [--allow-duplicate-name]` | `{playlist: Playlist, visibility: {requested_public, reported_public}}`. Requests private by default, but Spotify currently ignores `public: false` (see below); `playlist.public` is re-read after creation. Fails with `DUPLICATE_NAME` if you already own one with that name. |
| `playlist add <playlist> [refs...] [--from-file F] [--position N] [--allow-duplicates]` | `{playlist_id, added: [{uri, position}], skipped: [{uri, reason}], item_count, snapshot_id}`. Skips URIs already present unless `--allow-duplicates`. |
| `search tracks [query] [--track T] [--artist A] [--album B] [--year Y\|Y-Y] [--limit ≤10] [--offset N] [--market CC]` | `{query, market, limit, offset, total, next_offset, results: [Track]}` |
| `search tracks --from-file F [--workers 1-4] [--market CC]` | Batch: `{count, failed, searches: [{id, ok, …single-search fields \| error}]}`, in input order. `F` is a JSON array (max 50) of `{"id", "query", "track", "artist", "album", "year", "limit", "offset", "market"}`; unknown keys are rejected. One failed search does not fail the batch. |
| `track show <track> [--market CC]` | `{track: Track}` |
| `album tracks <album> [--market CC]` | `{album: {…, id, total_tracks, url}, tracks: [Track]}` |
| `plan remove <playlist> --positions "3,17,20-22" [--reason R]` | plan summary (below) |
| `plan reorder <playlist> (--order "…" \| --order-file F \| --move FROM:TO \| --by-recording-date) [--reason R]` | plan summary. `--by-recording-date` sorts by the local recording store (ties keep current order); fails with `RECORDING_DATES_MISSING` listing undated items. |
| `recordings show <playlist>` | `{playlist, items: [{position, uri, name, artists, isrc, recording, matched_by}], missing: [{position, uri, name}], chronological}` |
| `recordings set --from-file F` | `{created, updated, total, path}`. Validates every entry before writing anything. |
| `plan show <plan> [--check]` | `{plan_path, valid, applied, plan, check?: {applicable, same_snapshot, same_items, current_snapshot_id}}` |
| `plan apply <plan>` | `{applied, plan_id, playlist_id, operations_done, snapshot_id, verified, backup_path}` |

`<playlist>`, `<track>`, `<album>` accept a bare ID, a `spotify:` URI, or an `open.spotify.com` URL.
`<plan>` accepts a plan file path or a `plan_id`. `--from-file` accepts a JSON array (strings or
objects with `uri`) or one reference per line.

Plan summary: `{plan_path, plan_id, kind, playlist, summary: {items_before, items_after, operations}, changes}`.

## Plans (remove / reorder)

`plan remove` and `plan reorder` only read the playlist and write `plans/<plan_id>.json`:

```jsonc
{
  "schema_version": 1,
  "plan_id": "20260923T153000Z-reorder-AbCdEfGh-a1b2",
  "kind": "reorder",                       // or "remove"
  "created_at": "2026-09-23T15:30:00Z",
  "reason": "free text",
  "playlist": {"id", "uri", "name", "snapshot_id", "item_count"},
  "before": [{"position", "uri", "name", "artists": ["…"], "album", "duration"}],
  "changes": {"new_order": [0, 1, 35, 2, …], "moves": [{…op, "items": [{"from_position", "name", "artists"}]}]}
          // or {"remove": [compact items]}
  "after":  [{…compact item, "position", "from_position"}],
  "operations": [
    {"op": "move", "range_start": 35, "insert_before": 2, "range_length": 1},
    {"op": "delete_uris", "uris": ["…"]},
    {"op": "insert", "uris": ["…"], "position": 12}
  ],
  "warnings": [],
  "checksum": "sha256:…",                  // over playlist id, snapshot, before/after URIs, operations
  "applied": { … }                         // added by plan apply
}
```

- **Reorder** becomes upward block moves (`PUT …/items` with `range_start`/`insert_before`), which keep `added_at`.
  The full-replace mode is never used.
- **Remove**: the API deletes by URI, which removes *every* occurrence. If a URI appears more than once and
  only some occurrences go, the plan re-inserts the kept ones at their final positions (`REINSERTED_DUPLICATES`
  warning; their `added_at` resets).

`plan apply`:
1. Validates the schema and checksum (`PLAN_CHECKSUM_MISMATCH` if the file was edited), and re-simulates the
   operations to confirm they produce `after` (`PLAN_INCONSISTENT`). Refuses already-applied plans (`PLAN_ALREADY_APPLIED`).
2. Re-reads the playlist (without market, so URIs are exactly the stored ones) and requires the **same
   `snapshot_id` and the same URI list** as `before`; otherwise `SNAPSHOT_MISMATCH` and nothing changes.
3. Writes a full backup to `data/backups/`.
4. Runs the operations in order, chaining each returned `snapshot_id`. On failure: `APPLY_FAILED` with
   `operations_done`, the failed operation, and `backup_path`.
5. Re-reads the playlist and compares with `after`. Mismatch: `VERIFICATION_FAILED` (changes were applied).
6. Records `applied` in the plan file. The reported `snapshot_id` is the one returned by the last write.

## Recording dates

Spotify only knows an edition's release date. Recording dates are researched elsewhere and kept in
`data/recordings.json` (gitignored), keyed by track URI:

```json
{
  "spotify:track:…": {
    "recorded": "1947-12-05",
    "confidence": "high",
    "source": "AllMusic session notes",
    "note": "master take",
    "name": "Nostalgia",
    "artists": ["Fats Navarro"],
    "isrc": "…"
  }
}
```

- `recorded` is `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`.
- `confidence` is `high`, `medium`, or `low`.
- `source` is required.
- The other fields are optional.
- An entry's `isrc` also matches the same recording on another edition.
- Write entries with `recordings set` (input: a JSON array of entries with a `uri` field).

### Playlist visibility

Spotify ignores `public: false` when creating a playlist through the API, while its response echoes
the requested value (a long-standing issue, confirmed live on 2026-09-23). A later
`PUT /playlists/{id}` with `public: false` was also accepted (200) without effect. spotikit therefore
re-reads visibility after creating a playlist and warns with `VISIBILITY_NOT_APPLIED` (or
`VISIBILITY_UNVERIFIED` if the read says private). Make a playlist private from the Spotify app.
spotikit never changes the visibility of existing playlists.

### Snapshot read lag

After a write, Spotify keeps returning the previous `snapshot_id` on reads for a few minutes, while the
item list is already current. spotikit records the snapshot returned by each of its own writes (create,
add, apply) together with the expected URI list in `data/write_log.json`. A market-less read whose items
match that record exactly, within 15 minutes of the write, uses the recorded snapshot and emits
`SNAPSHOT_READ_LAG`. Any other difference is treated as a real change. The URI list check in `plan apply`
never relaxes.

## Error codes

`CONFIG_ERROR`, `AUTH_REQUIRED`, `AUTH_EXPIRED`, `AUTH_ERROR`, `AUTH_STATE_MISMATCH`, `INVALID_REFERENCE`,
`INVALID_ARGUMENT`, `API_BAD_REQUEST`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `API_ERROR`, `NETWORK_ERROR`,
`CONCURRENT_MODIFICATION`, `DUPLICATE_NAME`, `PLAN_INVALID`, `PLAN_NOT_FOUND`, `PLAN_CHECKSUM_MISMATCH`,
`PLAN_INCONSISTENT`, `PLAN_ALREADY_APPLIED`, `NO_CHANGES`, `SNAPSHOT_MISMATCH`, `APPLY_FAILED`,
`VERIFICATION_FAILED`, `RECORDING_DATES_MISSING`, `USAGE_ERROR`, `INTERNAL_ERROR`, `INTERRUPTED`.

## Tests

```bash
.venv/Scripts/python -m pytest
```

Plan logic is tested against an in-memory fake of the playlist API (`tests/fakes.py`).
