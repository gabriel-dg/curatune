# curatune reference

Details of the CLI's JSON contract, the plan mechanism, and the known Spotify API quirks curatune handles.
For what curatune does and how to set it up, see the [README](../README.md).
The MCP server's tools follow this contract with a few deliberate differences (1-based track numbers among
them); see [mcp.md](mcp.md).

## Authorization

OAuth 2.0 Authorization Code with PKCE (S256). `state` is random per login and validated (constant-time)
before any other callback parameter is used. The token file lives outside the repository. Spotify refresh
tokens expire 6 months after the original authorization; refreshing does not extend that. When Spotify
answers `invalid_grant`, the stored token is deleted and commands fail with `AUTH_EXPIRED`: run
`curatune auth login` again. The exception is a token file that another process has meanwhile updated with a
rotated refresh token: that token is used instead. `auth status` shows the estimated expiry.

## Output contract

```jsonc
// success (exit 0)
{"schema_version": 1, "ok": true, "command": "playlist show", "data": { ... }, "warnings": [ ... ]}
// failure (exit 1 = curatune error, 2 = usage, 3 = internal, 130 = interrupted)
{"schema_version": 1, "ok": false, "command": "plan apply", "error": {"code": "SNAPSHOT_MISMATCH", "message": "...", "details": { ... }}}
```

Warnings are objects `{"code", "message", ...}`. **Positions are 0-based everywhere.**

Every envelope (success or failure) also carries timing:

```json
"meta": {"elapsed_ms": 812.4, "http": {"api": {"calls": 4, "ms": 690.2}, "auth": {"calls": 1, "ms": 95.0}}}
```

- `elapsed_ms` is the command's own wall-clock time, excluding interpreter start-up and imports.
- `http.api` counts Spotify Web API requests, retries included.
- `http.auth` counts token exchanges and refreshes.
- In batch search, requests run concurrently, so `http.api.ms` is the sum of their durations and can
  exceed `elapsed_ms`.

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
| `auth status` | `{logged_in, user_id, display_name, client_id_matches, scopes, missing_scopes, authorized_at, refresh_expires_approx, refresh_likely_expired, access_token_expires_at, token_path, data: {data_dir, data_dir_explicit, legacy_data, virtualized}}`. `legacy_data` is `none`, `not_migrated`, or `migrated` (see [Data directory](#data-directory)). |
| `data migrate [--dry-run]` | `{source, data_dir, files, bytes, by_folder: {data, plans}, dry_run}`, plus `would_copy: [{from, to}]` with `--dry-run`, or `backup_dir`, `verified`, `originals_kept` after copying. |
| `auth logout` | `{logged_out, token_path, note}`. It only deletes the local token; `note` says to remove the app at https://www.spotify.com/account/apps to revoke access completely. |
| `playlists list [--owned-only]` | `{user_id, count, playlists: [Playlist]}` + warning `ITEM_COUNT_READ_LAG` |
| `playlist show <playlist> [--market CC] [--brief]` | `{playlist: Playlist, items: [PlaylistItem \| Brief track]}` + warnings `LOCAL_FILES`, `UNAVAILABLE_ITEMS`, `SNAPSHOT_READ_LAG` |
| `playlist create --name N [--description D] [--public] [--allow-duplicate-name]` | `{playlist: Playlist, visibility: {requested_public, reported_public}}`. Requests private by default, but Spotify currently ignores `public: false` (see below); `playlist.public` is re-read after creation. Fails with `DUPLICATE_NAME` if you already own one with that name. |
| `playlist add <playlist> [refs...] [--from-file F] [--position N] [--allow-duplicates]` | `{playlist_id, added: [{uri, position, name, artists}], skipped: [{uri, reason}], item_count, snapshot_id, verified}` + warning `ADD_NOT_VERIFIED`. Skips URIs already present unless `--allow-duplicates`. After adding, it reads the playlist back: `verified` says the items are exactly the expected ones, and `name`/`artists` come from that read (`null`/`[]` for an item not where it was put). |
| `search tracks [query] [--track T] [--artist A] [--album B] [--year Y\|Y-Y] [--limit ≤10] [--offset N] [--market CC] [--brief]` | `{query, market, limit, offset, total, next_offset, results: [Track \| Brief track]}` + warning `YEAR_IS_RELEASE_YEAR` when `--year` is used |
| `search tracks --from-file F [--workers 1-4] [--market CC] [--brief]` | Batch: `{count, failed, searches: [{id, ok, …single-search fields \| error}]}`, in input order. `F` is a JSON array (max 50) of `{"id", "query", "track", "artist", "album", "year", "limit", "offset", "market"}`; unknown keys are rejected. One failed search does not fail the batch. |
| `track show <track> [--market CC]` | `{track: Track}` |
| `album tracks <album> [--market CC] [--brief]` | `{album: {…, id, total_tracks, url}, tracks: [Track \| Brief track]}` |
| `plan remove <playlist> --positions "3,17,20-22" [--reason R]` | plan summary (below) |
| `plan reorder <playlist> (--order "…" \| --order-file F \| --move FROM:TO \| --sort-by KEY \| --by-recording-date) [--descending] [--reason R]` | plan summary. `--sort-by` is `title`, `artist`, `album`, `released`, `duration`, or `recorded` (the local recording store; `--by-recording-date` is the same); the rules are in [Sort orders](#sort-orders). `--descending` reverses the sort (only with `--sort-by`); ties keep their current order either way. `recorded` fails with `RECORDING_DATES_MISSING` listing undated items. |
| `plan details <playlist> [--name N] [--description D \| --description-file F] [--reason R]` | Plan summary with `summary: {fields}` and `changes: {field: {from, to}}`. At least one field is required; unchanged fields are left out (`NO_CHANGES` if nothing differs). Warns `DUPLICATE_NAME` if you own another playlist with the new name. An empty description fails with `DESCRIPTION_NOT_CLEARABLE`: the API can't clear one (see below). Visibility is never part of a plan. |
| `recordings show <playlist> [--brief]` | `{playlist, items: [{position, uri, name, artists, isrc, recording, matched_by}], missing: [{position, uri, name}], chronological}`; with `--brief`, items are `{position, uri, name, artists, recorded, confidence}` |
| `recordings set --from-file F` | `{created, updated, skipped, total, path}`. Validates every entry before writing anything. Overwrites stored entries (`skipped` is always empty here; the MCP server's additive `recordings_set` fills it). A URI repeated in the input: the last entry wins. |
| `plan show <plan> [--check]` | `{plan_path, valid, applied, plan, check?}`. For item plans, `check` is `{applicable, same_snapshot, same_items, current_snapshot_id}`; for details plans, `{applicable, same_values, current}`. |
| `plan apply <plan>` | Item plans: `{applied, plan_id, playlist_id, operations_done, snapshot_id, verified, backup_path}`. Details plans: `{applied, plan_id, playlist_id, operations_done, verified, current, backup_path}` + warning `DETAILS_NOT_CONFIRMED` when `verified` is false. |

`<playlist>`, `<track>`, `<album>` accept a bare ID, a `spotify:` URI, or an `open.spotify.com` URL.
`<plan>` accepts a plan file path or a `plan_id`; a bare `plan_id` must have the plan-ID shape
(`<UTC timestamp>-<kind>-<playlist ID prefix>-<4 hex>`), so it can never point outside the plans folder.
`--from-file` accepts a JSON array (strings or objects with `uri`) or one reference per line.

Plan summary: `{plan_path, plan_id, kind, playlist, summary: {items_before, items_after, operations}, changes}`.

## Plans (remove / reorder / details)

`plan remove` and `plan reorder` only read the playlist and write `plans/<plan_id>.json` in the data directory:

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
   operations to confirm they produce `after`. It also checks that the human-readable parts match what the
   plan does: `after` traces back to `before`, and `changes` (removals, `new_order`, `moves`) match the
   operations. Any mismatch fails with `PLAN_INCONSISTENT`, so a plan cannot show one change and apply
   another. Refuses already-applied plans (`PLAN_ALREADY_APPLIED`).
2. Re-reads the playlist (without market, so URIs are exactly the stored ones) and requires the **same
   `snapshot_id` and the same URI list** as `before`; otherwise `SNAPSHOT_MISMATCH` and nothing changes.
3. Writes a full backup to `backups/` in the data directory.
4. Runs the operations in order, chaining each returned `snapshot_id`. On failure: `APPLY_FAILED` with
   `operations_done`, the failed operation, and `backup_path`.
5. Re-reads the playlist and compares with `after`. Mismatch: `VERIFICATION_FAILED` (changes were applied).
6. Records `applied` in the plan file. The reported `snapshot_id` is the one returned by the last write.

### Details plans (rename and description)

`plan details` reads only the playlist's metadata and writes a plan with `"kind": "details"`:

```jsonc
{
  "kind": "details",
  "playlist": {"id", "uri", "name", "snapshot_id"},
  "before":  {"name": "Old name", "description": "Old text"},   // only the fields being changed
  "after":   {"name": "New name", "description": "New text"},
  "changes": {"name": {"from": "Old name", "to": "New name"}, "description": {"from": "…", "to": "…"}},
  "operations": [{"op": "set_details", "fields": {"name": "New name", "description": "New text"}}],
  "checksum": "sha256:…"                   // over playlist id, snapshot, before, after, operations
}
```

- Only `name` and `description` can appear. Validation rejects any other field (`PLAN_INCONSISTENT`),
  and the write primitive refuses one too, so visibility can never be changed through a plan.
- `plan apply` requires the **current values of the fields being changed** to equal `before`. Otherwise it
  fails with `SNAPSHOT_MISMATCH` and nothing changes. Item changes don't block a details plan.
- It backs up the metadata, sends `PUT /playlists/{id}` with only those fields, and reads the result back
  (up to 3 reads, 2 s apart). Spotify answers 200 even for changes it ignores (it does so for
  visibility), so `verified: false` plus the warning `DETAILS_NOT_CONFIRMED` means reads still show other
  values. That can be read lag or an ignored change; check in the Spotify app.
- Descriptions are exposed unescaped (Spotify returns them HTML-escaped, e.g. `&#x27;`).
- **A description can't be cleared through the API**: `PUT /playlists/{id}` with `description: ""`
  answers 200 and keeps the old text (verified live 2026-10-01). A description can only be replaced, so
  `plan details` refuses an empty one (`DESCRIPTION_NOT_CLEARABLE`); clear it in the Spotify app.
- A playlist created through the API without a description reads back as the literal string `"null"`.
  curatune reports it as `""` everywhere (lists, `playlist show`, plans). The cost: a description that
  really is the text `null` also shows as empty, and a plan that sets it to `null` ends with
  `verified: false` (the read-back shows `""`).
- A details write returns no `snapshot_id`. The next item plan on that playlist may therefore hit a
  one-off `SNAPSHOT_MISMATCH` while reads catch up; regenerate the plan.

### Sort orders

`plan reorder --sort-by` computes the order in code (`ordering.py`), with the same rules as curatune-web:

- Text keys are the title, the **first** artist, and the album name.
- Leading characters that are neither letters nor digits are ignored (`'Round Midnight` sorts as
  `Round Midnight`), then one leading English article `The ` (any case). No other article, in any
  language, is ignored.
- Case and accents are ignored: `Á` equals `a`.
- Runs of digits compare as numbers (`Track 2` before `Track 10`), and before letters.
- `released` compares the edition's release date as text (`1945` before `1945-11-26`); `duration`
  compares milliseconds; `recorded` uses the recording store.
- Items without a value go last, in both directions.
- Ties keep their current order, in both directions: `--descending` reverses the comparison, not the
  tie-break.

The order of punctuation and symbols inside names, and of non-Latin scripts, can differ from the web's
ICU collation.

## Recording dates

Spotify only knows an edition's release date. Recording dates are researched elsewhere and kept in
`recordings.json` in the data directory, keyed by track URI:

```json
{
  "spotify:track:…": {
    "recorded": "1947-12-05",
    "confidence": "high",
    "source": "AllMusic session notes",
    "note": "master take",
    "isrc": "…"
  }
}
```

- `recorded` is `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`.
- `confidence` is `high`, `medium`, or `low`.
- `source` is required.
- The other fields are optional.
- An entry's `isrc` also matches the same recording on another edition.
- Track names and artists are not stored: they are Spotify metadata, which Spotify's Developer Terms (IV.3)
  don't allow keeping indefinitely, and commands read them live from the playlist. Input entries may carry
  `name` and `artists` (older files do); they are accepted and dropped. Entries stored with them by older
  versions load as they are.
- Write entries with `recordings set` (input: a JSON array of entries with a `uri` field).

## Playlist visibility

Spotify ignores `public: false` when creating a playlist through the API, while its response echoes
the requested value (a long-standing issue, confirmed live on 2026-09-23). A later
`PUT /playlists/{id}` with `public: false` was also accepted (200) without effect. curatune therefore
re-reads visibility after creating a playlist and warns with `VISIBILITY_NOT_APPLIED` (or
`VISIBILITY_UNVERIFIED` if the read says private). Make a playlist private from the Spotify app.
curatune never changes the visibility of existing playlists.

## Snapshot read lag

After a write, Spotify keeps returning the previous `snapshot_id` on reads for a few minutes, while the
item list is already current. curatune records the snapshot returned by each of its own writes (create,
add, apply) together with the expected URI list in `write_log.json` (data directory). A market-less read whose items
match that record exactly, within 15 minutes of the write, uses the recorded snapshot and emits
`SNAPSHOT_READ_LAG`. Any other difference is treated as a real change. The URI list check in `plan apply`
never relaxes.

The playlist list lags too: `GET /me/playlists` keeps the old `items.total` for a while after a write.
`playlists list` reports, for playlists written within the last 15 minutes, the item count the write left
(the length of the recorded URI list) when it differs from the listed one, and emits
`ITEM_COUNT_READ_LAG` with both counts. `playlist show` counts the items it reads and is always current.

## Spotify API notes

How the Spotify Web API behaves where curatune depends on it. "Verified live" means observed on a real
account on that date; the rest is from Spotify's documentation and announcements, as of September 2026.

Access and limits:
- Development Mode: the app owner needs Premium. Apps created since 2026-02-11 allow 5 users, who must be
  added to the app's allowlist (others get 403). A developer can have up to 25 client IDs (since
  2026-07-23; it was 1), all sharing one quota per developer account. A used-up quota is a 429 with
  `"reason": "QUOTA_EXCEEDED"` (`API_QUOTA_EXCEEDED`). Extended quota is granted only to organizations (a
  registered business, a launched service, 250,000 monthly active users; since 2025-05-15).
- Scopes: `playlist-read-private`, `playlist-modify-public`, `playlist-modify-private`.
- Refresh tokens expire 6 months after the original authorization; refreshing doesn't extend that. Spotify
  then answers `invalid_grant` (`AUTH_EXPIRED`).

Catalog data:
- No audio features; since the 2026 migration, no `popularity`, `followers`, `label`, or
  `available_markets`.
- `release_date` is the edition's date, not the recording date.
- The ISRC (`external_ids`, restored in March 2026) helps match the same recording across editions, but it
  isn't fully reliable across remasters.
- The batch fetch endpoints (`GET /tracks?ids=` and the like) were removed; only single-item fetches remain.
- `GET /search` returns at most 10 results per request (`limit`); later pages come with `offset`.

Playlists:
- Items live at `/playlists/{id}/items` (GET, POST, PUT, DELETE); the old `/tracks` endpoints return 403. In
  responses, `tracks` became `items` and `track` became `item`. Items are returned only for playlists the
  user owns or collaborates on, at most 50 per page.
- Reads with and without a market returned identical URIs, so there is no relinking (verified live
  2026-09-23); `is_playable` comes only with a market. Plans always read without one.
- Visibility can't be set to private through the API (verified live 2026-09-23): see
  [Playlist visibility](#playlist-visibility).
- `PUT /playlists/{id}` with `name` and/or `description` is applied, and visible on the first read-back
  (verified live 2026-09-24, both fields in one call).
- A description can be replaced but not cleared: `description: ""` answers 200 and keeps the old text
  (verified live 2026-10-01). After clearing it in the Spotify app, the API reads `""`.
- A playlist created without a description reads back with the literal string `"null"` as its description
  (verified live 2026-10-01); curatune reports `""`. Whether sending `"description": ""` on create avoids
  it is unverified.
- `DELETE …/items` takes URIs only and removes **every** occurrence of each (verified live), so removal plans
  re-insert the copies you keep.
- `PUT …/items` either replaces the whole list (at most 100 items, resetting `added_at`) or moves a range;
  curatune only moves.
- After a write, reads return the previous `snapshot_id` for a few minutes while the items are already
  current, and the playlist list keeps the old item count (observed live, the list on 2026-09-29): see
  [Snapshot read lag](#snapshot-read-lag).
- `snapshot_id` is not a lock: Spotify applies changes made against a stale snapshot, so `plan apply`
  checks the playlist itself.

## Data directory

curatune keeps plans, backups, the write log, recording dates, and the MCP server's client records in one
data directory, shared by the CLI and the MCP server: `CURATUNE_DATA_DIR` if set (environment variables are
expanded), otherwise `%LOCALAPPDATA%\curatune\data` on Windows or `$XDG_DATA_HOME/curatune` (default
`~/.local/share/curatune`). Inside: `plans/`, `backups/`, `write_log.json`, `recordings.json`,
`mcp_clients.json`. It may not be inside the repository (`CONFIG_ERROR`), like the token.

On Windows, an app installed as an MSIX package (Claude Desktop is one) gets AppData virtualized for the
programs it starts ([Microsoft's documentation](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)): a new top-level folder under `%LOCALAPPDATA%` is really created in
`%LOCALAPPDATA%\Packages\<app>\LocalCache\Local\`, where a terminal never sees it and which uninstalling
the app deletes (observed 2026-10-02; new items inside a folder that already existed, such as
`%LOCALAPPDATA%\curatune` after a login from a terminal, stayed in place). Every command that uses the data
directory refuses one that resolves into a package (`DATA_DIR_VIRTUALIZED`, removing the empty folders it
just created), and `data migrate` checks before copying. Run curatune once from a terminal first, or set
`CURATUNE_DATA_DIR` to a folder inside your user profile, such as one in Documents (not in AppData).
`auth status` reports it as `data.virtualized`.

`CURATUNE_TOKEN_DIR` can't be set in the config directory's own `.env`: that directory is located before its
`.env` is read. Set it in the environment or in the repository's `.env`.

Earlier versions kept that data in the repository's `data/` and `plans/`. If they still hold files:
- with the default data directory, every command except `auth` and `data` stops with
  `LEGACY_DATA_NOT_MIGRATED`, so curatune never starts empty without saying so;
- with `CURATUNE_DATA_DIR` set, commands run and warn `LEGACY_DATA_PRESENT`.

`data migrate` fixes it: it copies (never moves) both folders, first to
`<data dir>/migration-backup-<UTC timestamp>/`, then to their places in the data directory, compares the
SHA-256 of every file in all three places, and writes `migration.json` (source, time, hashes). After that
nothing warns. It refuses to overwrite anything (`MIGRATION_CONFLICT`, nothing copied), runs once
(`ALREADY_MIGRATED`), and reports `NOTHING_TO_MIGRATE` when there's nothing to copy. The originals stay;
delete them yourself once you've checked the result.

`.env` is read from the repository (when curatune runs from one) and from the config directory next to the
token; the process environment wins over both, and the repository's file over the config directory's.

## Error codes

`CONFIG_ERROR`, `AUTH_REQUIRED`, `AUTH_EXPIRED`, `AUTH_ERROR`, `AUTH_STATE_MISMATCH`, `INVALID_REFERENCE`,
`INVALID_ARGUMENT`, `API_BAD_REQUEST`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `API_ERROR`, `NETWORK_ERROR`,
`CONCURRENT_MODIFICATION`, `DUPLICATE_NAME`, `PLAN_INVALID`, `PLAN_NOT_FOUND`, `PLAN_CHECKSUM_MISMATCH`,
`PLAN_INCONSISTENT`, `PLAN_ALREADY_APPLIED`, `NO_CHANGES`, `DESCRIPTION_NOT_CLEARABLE`, `SNAPSHOT_MISMATCH`, `APPLY_FAILED`,
`LEGACY_DATA_NOT_MIGRATED`, `DATA_DIR_VIRTUALIZED`, `TOKEN_DIR_VIRTUALIZED` (MCP `auth_login`), `NOTHING_TO_MIGRATE`, `ALREADY_MIGRATED`, `MIGRATION_CONFLICT`,
`MIGRATION_FAILED`,
`VERIFICATION_FAILED`, `RECORDING_DATES_MISSING`, `UNTRUSTED_URL`, `USAGE_ERROR`, `INTERNAL_ERROR`, `INTERRUPTED`,
`API_QUOTA_EXCEEDED`.

`API_QUOTA_EXCEEDED`: Spotify answered 429 with `"reason": "QUOTA_EXCEEDED"`. The quota belongs to the
developer account and is shared by all its Development Mode apps (since July 2026); unlike `RATE_LIMITED`,
waiting for `Retry-After` doesn't help, so it is not retried.

`UNTRUSTED_URL`: a response pointed to a URL (such as a pagination `next` link) outside
`https://api.spotify.com`. The request is refused so the access token is never sent elsewhere.

Warning codes (in `warnings`; the command still succeeded):

| Code | Meaning |
|---|---|
| `SNAPSHOT_READ_LAG` | The read returned a stale `snapshot_id`; the one from curatune's last write is used. |
| `LEGACY_DATA_PRESENT` | `CURATUNE_DATA_DIR` is set, and the repository's older `data/` or `plans/` still hold files it doesn't use (`legacy_dirs`, `data_dir`). `data migrate` copies them, if wanted. |
| `ITEM_COUNT_READ_LAG` | The playlist list returned stale item counts; the counts left by curatune's recent writes are used (`playlists`: `playlist_id`, `listed_item_count`, `item_count`). |
| `LOCAL_FILES` | The playlist contains local files. |
| `UNAVAILABLE_ITEMS` | Some items have no track object and no URI. |
| `YEAR_IS_RELEASE_YEAR` | `--year` filters on the edition's release year, not the recording year. |
| `VISIBILITY_NOT_APPLIED` | A private playlist was requested but Spotify made it public. |
| `VISIBILITY_UNVERIFIED` | Spotify reports the playlist as private but is known to ignore it. |
| `REINSERTED_DUPLICATES` | A removal plan re-inserts kept copies of a repeated URI, and their `added_at` resets. |
| `LOCAL_FILE_REMOVAL` | A removal plan touches local files; removing them through the API is unverified. |
| `DUPLICATE_NAME` | A details plan renames the playlist to a name you already use for another playlist. |
| `DETAILS_NOT_CONFIRMED` | A details plan was sent and accepted (HTTP 200), but reads still show other values. |
| `ADD_NOT_VERIFIED` | Spotify accepted the addition, but reading the playlist back shows a different item list, for example after a simultaneous change elsewhere (`expected_item_count`, `read_item_count`), or the read itself failed (`read_error`: the error code). The tracks were added either way. |
