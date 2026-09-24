---
name: spotikit
description: Work with the user's own Spotify playlists through the spotikit CLI in this repository. List and read playlists, search the catalog, create playlists, add tracks, plan and apply removals or reorders, and keep recording-date metadata. Use for any request about the user's Spotify playlists, such as curating, completing, de-duplicating, ranking, analyzing, or reordering them.
allowed-tools: PowerShell(.\.venv\Scripts\spotikit.exe auth status) PowerShell(.\.venv\Scripts\spotikit.exe playlists list *) PowerShell(.\.venv\Scripts\spotikit.exe playlist show *) PowerShell(.\.venv\Scripts\spotikit.exe search tracks *) PowerShell(.\.venv\Scripts\spotikit.exe track show *) PowerShell(.\.venv\Scripts\spotikit.exe album tracks *) PowerShell(.\.venv\Scripts\spotikit.exe recordings show *) PowerShell(.\.venv\Scripts\spotikit.exe plan show *) PowerShell(.\.venv\Scripts\spotikit.exe plan remove *) PowerShell(.\.venv\Scripts\spotikit.exe plan reorder *) Bash(.venv/bin/spotikit auth status) Bash(.venv/bin/spotikit playlists list *) Bash(.venv/bin/spotikit playlist show *) Bash(.venv/bin/spotikit search tracks *) Bash(.venv/bin/spotikit track show *) Bash(.venv/bin/spotikit album tracks *) Bash(.venv/bin/spotikit recordings show *) Bash(.venv/bin/spotikit plan show *) Bash(.venv/bin/spotikit plan remove *) Bash(.venv/bin/spotikit plan reorder *) Bash(.venv/Scripts/spotikit.exe auth status) Bash(.venv/Scripts/spotikit.exe playlists list *) Bash(.venv/Scripts/spotikit.exe playlist show *) Bash(.venv/Scripts/spotikit.exe search tracks *) Bash(.venv/Scripts/spotikit.exe track show *) Bash(.venv/Scripts/spotikit.exe album tracks *) Bash(.venv/Scripts/spotikit.exe recordings show *) Bash(.venv/Scripts/spotikit.exe plan show *) Bash(.venv/Scripts/spotikit.exe plan remove *) Bash(.venv/Scripts/spotikit.exe plan reorder *)
---

# spotikit: working with the user's Spotify playlists

The user asks in natural language. You fulfil the request by combining spotikit commands. The user
never runs commands by hand.

- **spotikit is the execution layer.** It runs deterministic API operations and returns JSON. It
  contains no judgment.
- **You are the judgment layer.** You interpret the request, apply domain knowledge (and web search
  when needed), choose recordings, and explain every decision, including your confidence in it.

Per-playlist curation criteria and personal preferences may be in `CLAUDE.local.md` (gitignored). Follow
them when present.

## Invoking the CLI

The working directory is already the repository root. Use the prefix for your shell and OS:

| Shell | OS | Command prefix |
|---|---|---|
| PowerShell | Windows | `.\.venv\Scripts\spotikit.exe` |
| Bash (Git Bash) | Windows | `.venv/Scripts/spotikit.exe` |
| Bash | macOS, Linux | `.venv/bin/spotikit` |

**One spotikit command per tool call, exactly as `<prefix> <command> <args>`.** Do not add `cd`, loops,
pipes, `&&`, or inline scripts. The pre-approved read-only permissions only match that exact shape, and
one command per call keeps failures isolated.

Every call prints one JSON envelope:
`{"schema_version":1,"ok":true|false,"command":…,"data"|"error":…,"warnings":[…],"meta":{…}}`.

- Always check `ok`.
- Read `warnings`.
- `meta` holds timing: `elapsed_ms` plus `http.api` / `http.auth` call counts and milliseconds. In batch
  search, `http.api.ms` sums concurrent requests; report `elapsed_ms` as the wall-clock time.
- Positions in JSON are **0-based**. Use 1-based numbering when talking to the user.
- Refs accept a bare ID, a `spotify:` URI, or an `open.spotify.com` URL.

**Read with `--brief`.** `playlist show`, `search tracks`, `album tracks`, and `recordings show` accept it,
and it is about a third of the size of the full output. Each track becomes a flat object:
`{"position", "uri", "name", "artists": ["name", …], "album": "name", "released", "duration", "isrc", "playable"}`.

- `position` appears only for playlist items.
- `released` is the edition's date.
- `recordings show --brief` items are `{"position", "uri", "name", "artists", "recorded", "confidence"}`.

Read the JSON directly. **Do not write scripts to reformat or summarize it.** If you need a field that
`--brief` omits (for example `added_at`, artist or album URIs, `disc_number`), run the command without
`--brief`. Note that in the full output `artists` is a list of objects `{"name", "uri"}` and `album` is an
object. Full shapes and error codes: `README.md`.

Put input files for `--from-file` (queries, items, recordings) in a temporary or scratch directory, not in
the repository.

**Never** mutate Spotify outside these commands. That means no ad-hoc scripts, no importing the library,
and no calling private functions such as `_writes`.

## First-time setup

Do this when `.venv` is missing, or a command fails with `CONFIG_ERROR` or `AUTH_REQUIRED`.

1. Create the environment yourself:
   ```
   python -m venv .venv
   <venv python> -m pip install -e ".[dev]"
   ```
   Requires Python 3.10 or newer.
2. The user creates a Spotify app at https://developer.spotify.com/dashboard:
   - select **Web API** only;
   - register the redirect URI `http://127.0.0.1:8888/callback` exactly (portless URIs are rejected);
   - the app owner needs Spotify Premium.
3. The user copies `.env.example` to `.env` and sets `SPOTIFY_CLIENT_ID`. No client secret is used (PKCE).
   Never ask for credentials in chat.
4. Run `auth login`. It opens a browser and the user approves. Then check `auth status`: `missing_scopes`
   must be empty.

On `AUTH_EXPIRED`, ask the user to re-run `auth login`. Refresh tokens expire 6 months after the
authorization. Do not try to work around it.

## Rules (also enforced in code)

- **Create and add:** execute directly.
- **Remove and reorder:**
  1. Only build a **plan**.
  2. Show it to the user (1-based positions; what moves or leaves, and why).
  3. Wait for an **explicit OK for that specific plan**. Approval never carries over to another plan.
  4. Then `plan apply`.
- If `plan apply` returns `SNAPSHOT_MISMATCH`, nothing was changed. Regenerate the plan and ask again.
- **Never change a playlist's name, description, or visibility.** spotikit has no command for it, on purpose.
- Only playlists the user owns or collaborates on can be read item-by-item or modified.

## Commands

| Command | Effect |
|---|---|
| `auth login` / `auth status` / `auth logout` | Authorization. The user completes the browser flow. |
| `playlists list [--owned-only]` | The user's playlists. |
| `playlist show <playlist> [--market CC] [--brief]` | Metadata and all items (position, name, artists, album, duration, ISRC, URI; the full output adds `added_at` and more). |
| `playlist create --name N [--description D] [--public] [--allow-duplicate-name]` | **Executes.** See the visibility note below. |
| `playlist add <playlist> [refs…] [--from-file F] [--position N] [--allow-duplicates]` | **Executes.** Appends by default. Skips URIs already present. |
| `search tracks [q] [--track --artist --album --year] [--limit ≤10] [--offset N] [--brief]` | One search, 10 results at most. |
| `search tracks --from-file queries.json [--workers 1-4] [--brief]` | **Batch**: many searches concurrently, results in input order. Prefer it whenever there is more than one search. |
| `track show <track>` | One track, with ISRC. |
| `album tracks <album> [--brief]` | Full album listing. Use it to find the master take inside a specific edition. |
| `recordings show <playlist> [--brief]` | Join items with the local recording-date store. Reports `missing` and `chronological`. |
| `recordings set --from-file F` | Add or update recording dates. Validated all-or-nothing. |
| `plan remove <playlist> --positions "3,17,20-22"` | Plan only. |
| `plan reorder <playlist> (--order … \| --order-file F \| --move FROM:TO \| --by-recording-date)` | Plan only. |
| `plan show <plan> [--check]` | Validate and show a plan. `--check` compares it with the live playlist. |
| `plan apply <plan>` | Only after the user's OK. Checks snapshot and items, backs up, applies, verifies. |

Batch query file:
`[{"id": "rain", "track": "Rain", "artist": "The Beatles"}, {"id": "q2", "query": "free text", "year": "1945-1947"}]`

Allowed keys: `id`, `query`, `track`, `artist`, `album`, `year`, `limit`, `offset`, `market`.

Recording entries:
`[{"uri": "spotify:track:…", "recorded": "1947-12-05", "confidence": "high", "source": "…", "note": "…"}]`

- `recorded` may be `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`.
- `confidence` is `high`, `medium`, or `low`.
- `source` is required.
- Optional keys: `name`, `artists`, `isrc` (an ISRC also matches the same recording on another edition).

## Workflows

**Read or analyze a playlist.** Run `playlist show --brief`. Base every claim about a track (period, take,
importance, relationships between tunes) on your knowledge or on sources, and say how sure you are.

**Find the right recording.**
1. Batch-search all candidates at once (`search tracks --from-file F --brief`).
2. When an edition matters (original label, "Master Takes" collections, remasters), run
   `album tracks --brief` on it and pick the exact take.
3. Weigh the signals:
   - album and label names;
   - durations (for example, 78 RPM sides run about 2:30–3:20);
   - suffixes such as "Alternate", "Take N", "Live", "Remake", "Demo", "Mono";
   - ISRC.
4. Reject karaoke, covers, and tribute acts.
5. If the best option is uncertain, say so.

**Add tracks.**
1. Pick the tracks.
2. Run one `playlist add` with all URIs.
3. Report what was added and why, plus any doubts.
4. If the playlist is kept in an order (for example chronological): store the new tracks' recording dates
   with `recordings set`, then propose `plan reorder --by-recording-date` and wait for the OK.

**Create a playlist.**
- Spotify currently ignores `public: false`, and spotikit reports `VISIBILITY_NOT_APPLIED`.
- Tell the user the playlist is public and that they can make it private in the Spotify app.
- Never claim it is private.
- If the new playlist must be in an order (for example chronological), decide the order first and add
  the tracks already in that order with one `playlist add`. Adding needs no plan, so no reorder plan or
  approval is needed. Store the recording dates with `recordings set`, then confirm the result with
  `recordings show --brief` (`chronological: true`).

**Reorder chronologically.**
1. Run `recordings show --brief`.
2. Research dates for the `missing` items. Spotify's `release_date` is the **edition** date, never the
   recording date. Use discographies and state sources.
3. Run `recordings set`.
4. Run `plan reorder --by-recording-date`. Ties keep their current order.
5. Show the plan. Point out anything surprising, such as earlier misplacements or low-confidence dates.
6. Apply only after the OK.

**Duplicates and repeated versions.**
- Detect them from `playlist show --brief`: the same ISRC, the same composition under another title, or
  alternate, live, or re-recorded versions of a tune already present.
- Explain each case. Removal goes through `plan remove`.

## Data limitations

- No audio features, popularity, followers, or labels from Spotify. Rankings and criteria rely on your
  knowledge or external sources.
- **When there is no reliable information, say so instead of inventing it.**

## Warnings and errors: what to do

| Code | Action |
|---|---|
| `SNAPSHOT_READ_LAG` (warning) | Normal right after a write. Nothing to do. |
| `YEAR_IS_RELEASE_YEAR` (warning) | `--year` matches the edition's release year. Don't use it to find period recordings on later compilations. |
| `VISIBILITY_NOT_APPLIED` / `VISIBILITY_UNVERIFIED` | Tell the user the playlist is or may be public. |
| `LOCAL_FILES`, `UNAVAILABLE_ITEMS` | Mention them. Items without a URI cannot be removed through the API. |
| `REINSERTED_DUPLICATES` (plan) | Removing one copy of a repeated URI re-inserts the kept copies, and their `added_at` resets. Mention it when presenting the plan. |
| `DUPLICATE_NAME` | Ask whether to reuse the existing playlist or create another one (`--allow-duplicate-name`). |
| `RECORDING_DATES_MISSING` | Research and `recordings set` the listed items, then retry. |
| `NO_CHANGES` | The playlist is already in the requested order. |
| `SNAPSHOT_MISMATCH` | Nothing changed. Regenerate the plan and ask for approval again. |
| `APPLY_FAILED` / `VERIFICATION_FAILED` | Report it with `backup_path`. Do not retry blindly. |
| `AUTH_REQUIRED` / `AUTH_EXPIRED` / `CONFIG_ERROR` | Follow "First-time setup". |
| `RATE_LIMITED` | Wait `retry_after_seconds`, then retry. Avoid large bursts: the quota is shared by the developer account. |

## Reporting

- Answer in the user's language.
- Summarize what you did, the choices you made and their confidence, and anything you did not do.
- When timing matters, report API time from `meta` (not your own thinking time), per phase: search, create,
  add, plan, apply.
