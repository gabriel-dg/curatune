# spotikit

Deterministic toolkit for Spotify playlists: a Python library (`src/spotikit`) plus a thin CLI.
Every CLI call prints exactly one JSON document to stdout. Judgment (what to add, what counts as
a duplicate, how to rank) is intentionally **not** in this code.

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
| `playlist create --name N [--description D] [--public] [--allow-duplicate-name]` | `{playlist: Playlist}`. Private by default; fails with `DUPLICATE_NAME` if you already own one with that name. |
| `playlist add <playlist> [refs...] [--from-file F] [--position N] [--allow-duplicates]` | `{playlist_id, added: [{uri, position}], skipped: [{uri, reason}], item_count, snapshot_id}`. Skips URIs already present unless `--allow-duplicates`. |
| `search tracks [query] [--track T] [--artist A] [--album B] [--year Y\|Y-Y] [--limit ≤10] [--offset N] [--market CC]` | `{query, market, limit, offset, total, next_offset, results: [Track]}` |
| `track show <track> [--market CC]` | `{track: Track}` |
| `album tracks <album> [--market CC]` | `{album: {…, id, total_tracks, url}, tracks: [Track]}` |
| `plan remove <playlist> --positions "3,17,20-22" [--reason R]` | plan summary (below) |
| `plan reorder <playlist> (--order "…" \| --order-file F \| --move FROM:TO) [--reason R]` | plan summary |
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
`VERIFICATION_FAILED`, `USAGE_ERROR`, `INTERNAL_ERROR`, `INTERRUPTED`.

## Tests

```bash
.venv/Scripts/python -m pytest
```

Plan logic is tested against an in-memory fake of the playlist API (`tests/fakes.py`).
