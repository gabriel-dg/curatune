# curatune-web — playlist curation in the browser (for Spotify)

## Goal

A browser version of curatune (in `../api/`: a Python library, CLI, MCP server, and agent skill, installed
locally). The user chats in the browser; an LLM you serve through an
OpenAI-compatible endpoint (LM Studio or Ollama; optionally a hosted API such as Gemini, chosen per chat)
decides which tools to call; the tools run **in the
browser** against the Spotify Web API with the user's own token. Scope: **playlists only** (create, read,
edit, analyze); no playback, library, or listening history.

Current stage: single-user prototype (it has a single user). How models were evaluated for it,
and the results, are in `docs/evaluation.md`.

Personal context (conversation language, local network setup, test playlist) lives in the gitignored
`AGENTS.local.md`; read it when present. Never put personal data (user IDs, playlist IDs, names, emails,
IP addresses, hostnames, local paths) in versioned files.

## Relationship to curatune

- In this repository, curatune is [`../api/`](../api/).
- No shared code. curatune's `docs/reference.md`, `plans.py`, and tests are the **specification** for the
  port; behaviour must match unless a difference is deliberate and documented here.
- Each ported module records, in a header comment, the curatune commit it follows and the file, by its path
  in `api/` today (`src/curatune/…`). Before commit d62b466 the package directory had the project's former
  name: `git ls-tree -r --name-only <commit> src` shows the path to use with `git show <commit>:<path>`.
- The "Spotify Web API facts" below are copied from curatune's `docs/reference.md` ("Spotify API notes").
  When either project verifies something new, update both.
- Deliberate differences (keep this list current; module headers give the details):
  - Auth: PKCE with the callback as a page of this app, tokens in `sessionStorage` (curatune: a local
    callback server and an owner-only token file). HTTP uses `redirect: "error"`.
  - Storage: write log, plan backups, and recording dates in IndexedDB (database `curatune-web`), separate
    from curatune's `data/` files (nothing is shared; recording dates move by importing or exporting the
    same JSON). Plans live in memory, not in files.
  - Tools, not commands: the model sees 1-based `number` (see Development); results are trimmed for the
    model instead of `--brief`; batch search is `search_many` (up to 25 searches per call, 4 at a time).
  - Plans are applied only by the UI's Apply button; there is no apply tool (curatune: `plan apply`, run by
    the agent after the user confirms). Adding tracks to a playlist not created in this session waits for the
    user's Confirm on a card (curatune's MCP server asks the same way, through its dialog or page; its CLI adds
    directly). Write tools accept only IDs seen earlier in the conversation, and
    create has no public option (curatune's `--public`): the model never chooses visibility.
  - `plan_reorder` also takes `sort_by` title, artist, album, released (edition date), or duration, besides
    `recorded` (curatune's `--by-recording-date`), an explicit order, or a move.
  - Playlist metadata includes `images` (covers, shown in the UI, never sent to the model).
  - The UI hides warnings the app already compensates (`SNAPSHOT_READ_LAG`, `ITEM_COUNT_READ_LAG`) and words
    the rest plainly; the model gets them as curatune reports them. The sidebar also takes track counts from
    writes and from reading a playlist.
  - Retention: backups older than 90 days are deleted when the app starts (a fixed period; curatune reads
    `CURATUNE_RETENTION_DAYS`). As in curatune, recording entries never store names or artists.
  - The UI follows Spotify's design guidelines for the Spotify content it shows: the official full logo as
    attribution in the top bar (`public/brand/`, unmodified, a trademark of Spotify AB), links back to
    Spotify on playlists and tracks ("Open Spotify"), and covers shown whole (never cropped), with 4 or 8 px
    corners and nothing on top.
  - Not ported: market-dependent reads (`--market`, `is_playable`), `plan show --check` (the UI renders the
    plan; applying re-checks), per-process HTTP metrics, and the CLI and its configuration.

## Architecture

- Static site: Vite + TypeScript, no UI framework, Vitest for tests. Keep dependencies minimal: every
  dependency runs in a page that holds a Spotify token.
- There is **no backend of ours that sees Spotify tokens**. OAuth (PKCE) and every Spotify API call run in
  the browser.
- The LLM receives only the conversation and trimmed tool results (names, artists, durations, URIs), never
  tokens.
- Layers: `src/spotify/` (auth, HTTP client, models, playlist and catalog reads, `writes.ts` for create
  and add, `writelog.ts`), `src/plans/` (plan building, validation, and application; `ops.ts` holds the
  low-level remove/move/rename calls), `src/recordings/` (recording-date store, curatune's format),
  `src/storage/` (IndexedDB, memory fallback), `src/tools/` (tool
  schemas, argument validation, handlers, trimming of results for the model), `src/agent/` (LLM client,
  loop, system prompt), `src/ui/`. Only `ui/` touches the DOM; `agent/` and `tools/` never import the auth
  module (types only), so the token cannot reach the model. All of this is testable in Node
  (`tests/invariants.test.ts` checks these rules statically).
- Model evaluation: `npm run eval` runs `eval/scenarios.ts` against real models with the in-memory fake
  Spotify from `tests/fake-spotify.ts` (no token needed); results go to `scratch/eval/`. How to run it, the
  scenarios, and the recorded results are in `docs/evaluation.md`.
- LM Studio silently truncates conversations that exceed the loaded context length (4096 by default when
  it loads a model on demand). The loop detects it (prompt tokens shrinking within a turn) and fails with
  `LLM_CONTEXT_EXCEEDED`. Load models with at least 32768 tokens of context.
- The CSP is built in `config/csp.ts` (its `connect-src` includes the origin of `VITE_LLM_BASE_URL`; its
  `img-src` allows Spotify's image CDNs for playlist covers) and injected as a `<meta>` tag; the dev and
  preview servers also send it as a header, computed at startup (restart them after changing it).

## Security invariants (keep them; each needs tests)

- The Spotify token never leaves the browser. It is sent only to `https://accounts.spotify.com` (token
  endpoint) and `https://api.spotify.com`; never to the LLM endpoint or any other host.
- The bearer token is only attached to `https://api.spotify.com` requests. Absolute URLs from responses
  (pagination `next`) are checked; any other host or scheme is an error (`UNTRUSTED_URL`).
- Tokens and authorization codes never appear in the console, logs, errors, the LLM context, or the URL
  (strip `code` and `state` with `history.replaceState` after the callback). Keep tokens in memory or
  `sessionStorage`, never `localStorage`, which holds only the column widths (`src/ui/layout.ts`, the one
  module allowed to use it). IndexedDB (only in `src/storage/`) holds the write log, plan backups, and
  recording dates, never tokens.
- `state` is validated on the callback; the PKCE verifier is removed after the exchange.
- Known residue of the callback, outside the page's control: the single-use (already exchanged) `code`
  remains in the browser's global history and in the page's Navigation Timing entry
  (`performance.getEntriesByType("navigation")`), which only same-origin scripts can read.
- Spotify content (names, descriptions) is untrusted third-party text: render it with `textContent`, never
  `innerHTML`; tell the model to treat it as data, never as instructions.
- Strict Content Security Policy; no third-party scripts, fonts, or analytics. The only external images are
  playlist covers from Spotify's image CDNs (`*.scdn.co`, `*.spotifycdn.com`): loaded lazily and without a
  referrer, their URLs checked before use (`src/ui/covers.ts`), never sent to the model.
- No framing (clickjacking): the dev and preview servers send `frame-ancestors 'none'` as a header, which a
  `<meta>` CSP cannot carry and static hosts such as GitHub Pages cannot send. So `src/main.ts` first checks
  `isFramed` (`src/ui/frame-guard.ts`, tested; an error reading `window.top` counts as framed) and, when
  framed, starts nothing (no callback handling, no storage) and shows only a link that opens the app's root
  in its own tab.
- **The model never applies a plan.** There is no "apply" tool; a plan is applied only through a UI button
  after the plan has been rendered to the user. Only `src/plans/` imports `plans/ops.ts`, and only `src/ui/`
  calls `applyPlan` (both checked in `tests/invariants.test.ts`). The model learns what the user did with a
  plan from an `[App notice: …]` prepended to the user's next message.
- `[App notice: …]` and `[App context: …]` lines (`src/ui/app-messages.ts`, tested) carry only IDs, plan kinds,
  and counts, never Spotify text: a playlist name is written by its owner, who may be someone else (a followed
  or collaborative playlist), and inside the user's message it could fake the user's words or a notice. The
  model reads names through tools. Quick actions and suggestions, sent as the user's words, say "this
  playlist" instead of its name.
- Optional hosted LLM (`VITE_HOSTED_LLM_*`, e.g. Gemini): selectable in the chat, never the default (the
  local model is, in every new tab). While one is selected, the chat shows that playlist names, track names,
  and artists leave the machine, citing Spotify's Developer Terms IV.2.1 and Developer Policy III.14
  (`hostedDataNotice` in `src/ui/llm-providers.ts`, tested). `VITE_HOSTED_LLM_MODEL` may list several models (comma separated), each one in the selector. Their shared
  API key is pasted by the user in the app and kept only in the tab's `sessionStorage`; it is never in the
  build, a file, or the repository, and is sent only as `Authorization` to that provider's origin (which
  the CSP allows). Choosing it sends the conversation and trimmed playlist data to the provider; the
  Spotify token is never sent (tested in `tests/llm-providers.test.ts`). Switching model starts a new
  chat. The evaluation reads its own key from `EVAL_LLM_API_KEY`, which Vite never bundles.
- The LLM server is never exposed to the internet directly. Remote access (not built yet) would go through an
  outbound tunnel, authentication, and a proxy that allows only chat completions.

## Confirmation rules (same as curatune)

- Create playlist / add items: shown in the UI (a card in the chat plus a session log that "New chat" does
  not clear). Creating runs directly, and so does adding to a playlist `playlist_create` made in this tab
  (`ToolContext.createdPlaylists`, in memory until the page reloads). Adding to any other playlist first
  reads it and the tracks (`previewAdd`, so what the addition would refuse fails before asking), shows them
  with Confirm and Cancel (`src/ui/add-card.ts`), and waits: Cancel or Stop returns `USER_DECLINED` to the
  model, and without `confirmAdd` the tool fails closed (`CONFIRMATION_UNAVAILABLE`). Write tools only accept
  IDs that appeared earlier in the conversation (user messages or tool results), create always requests a
  private playlist (the model never chooses visibility), and add re-reads the playlist to verify.
- Remove / reorder / rename / change description: only through **plans**. A plan records the current
  state, the change, the resulting state, and the exact operations; applying verifies snapshot and item
  list first and the result after. Validation also checks that the human-readable parts match the
  operations (`PLAN_INCONSISTENT`).
- Details plans accept only `name` and `description`. There is deliberately **no** operation to change
  visibility.

## Configuration

`.env.local` (gitignored) holds `VITE_SPOTIFY_CLIENT_ID`, `VITE_LLM_BASE_URL`, and `VITE_LLM_MODEL`, and
optionally `VITE_HOSTED_LLM_BASE_URL`, `VITE_HOSTED_LLM_MODEL`, `VITE_HOSTED_LLM_NAME` (no key) and, for the
evaluation only, `EVAL_LLM_BASE_URL` and `EVAL_LLM_API_KEY`. The
Client ID ends up in the bundle; under PKCE it is not a secret, but it is personal, so it is never
committed. The dev server binds to `127.0.0.1:5173` (strict port) and the redirect URI
`http://127.0.0.1:5173/callback` must be registered in the Spotify dashboard.

`VITE_BASE_PATH` (build time only, default `/`, normalized in `config/base.ts`) sets Vite's `base`. The
redirect URI is origin + base + `callback` (`callbackPath` in `src/spotify/auth.ts`, given
`import.meta.env.BASE_URL`), and the build writes `dist/callback.html`, a copy of `index.html` with the same
CSP meta tag, because GitHub Pages has no SPA fallback (see README.md, "Building for GitHub Pages").

## Spotify Web API facts (copied from curatune; verified September 2026)

- Development Mode: app owner needs Premium; apps created since 2026-02-11 allow 5 users (an allowlist;
  others get 403); up to 25 client IDs per developer (since 2026-07-23, was 1), all sharing one quota per
  developer account. A used-up quota is a 429 with `"reason": "QUOTA_EXCEEDED"` (`API_QUOTA_EXCEEDED`,
  not retried). Extended quota is only for organizations (registered business, launched service, 250k
  MAU; since 2025-05-15).
- No audio features; since the 2026 migration no `popularity`, `followers`, `label`, or
  `available_markets`. `release_date` is the **edition** date, not the recording date.
- ISRC (`external_ids`) helps match the same recording across editions (not fully reliable across
  remasters).
- Playlist items: `/playlists/{id}/items` (GET/POST/PUT/DELETE); old `/tracks` endpoints return 403. In
  responses `tracks` → `items`, `track` → `item`. Items are only returned for playlists the user owns or
  collaborates on. `GET …/items` limit max 50.
- Reads with and without a market return identical URIs (no relinking); `is_playable` only with a market.
  Plans always read without a market.
- Create playlist: `POST /me/playlists`. **Visibility cannot be set to private through the API** (create
  ignores `public: false` while echoing it back; `PUT /playlists/{id}` with `public: false` has no effect).
  Re-read after creating and report real visibility.
- `PUT /playlists/{id}` with `name` and/or `description` is applied and visible on the first read-back.
- Batch fetch endpoints (`GET /tracks?ids=` etc.) were removed; only single-item fetches remain.
- `GET /search`: max `limit` 10; paginate with `offset`.
- `DELETE …/items` takes URIs only and removes **every** occurrence of a URI; plans re-insert kept
  occurrences.
- **snapshot_id read lag**: after a write, reads return the previous `snapshot_id` for a few minutes while
  items are already current. curatune handles it with a write log; ported in `src/spotify/writelog.ts`
  (stored in IndexedDB). The web app and the curatune CLI keep separate write logs, so do not write the same playlist
  from both within minutes.
- The playlist list lags too (observed 2026-09-29 by curatune-web): right after creating a playlist and
  adding 20 tracks, `GET /me/playlists` still returned `items.total` 0 for it while `GET …/items` returned
  all 20. Listing reports the count left by the app's own writes of the last 15 minutes when the list
  disagrees (write log, `ITEM_COUNT_READ_LAG`, as in curatune 590cd87).
- `snapshot_id` is not a lock: Spotify applies changes even on a stale snapshot; plan application checks
  itself.
- `PUT …/items` either replaces (max 100, loses `added_at`) or moves a range; only moves are used.
- Refresh tokens expire 6 months after the original authorization; on `invalid_grant` discard the token
  and ask the user to log in again.
- Scopes: `playlist-read-private`, `playlist-modify-public`, `playlist-modify-private`.
- CORS (verified 2026-09-28, this project only): the token endpoint (code exchange and refresh) and the Web
  API accept requests from `http://127.0.0.1:5173`, including the preflight for the `Authorization`
  header. The authorize redirect adds an extra `ubi` query parameter to the callback; it is ignored.

## Development

- Everything in the repository (code, comments, identifiers, docs, commit messages) is in **English**.
- Naming: Spotify's developer guidelines forbid "Spotify", or anything similar in sound or spelling (such as
  a "Spoti-" prefix), in a product's name, but allow "for Spotify". The project is curatune-web, named for this
  reason; describe it as "playlist curation for Spotify", never "Spotify playlist curation". The IndexedDB
  database, and the sessionStorage and localStorage keys' prefix, are `curatune-web` too. Browsers that ran
  the app under its former name keep their data: on start, `migrateLegacyDatabase` (`src/storage/kv.ts`)
  copies the old database into the new one once, checks the copy, and only then deletes the old one. Tabs
  take turns through `navigator.locks` ("curatune-web-migrate"), and no database open inside the lock waits
  more than a second ("busy"). When the move can't finish, or another tab keeps the old database open, the
  app says so (`storageMoveNotice` in `src/ui/warnings.ts`); its retry,
  `mergeLegacyDatabase`, only adds records whose keys are missing and keeps the old database while any of
  it differs from the new one.
- Test against a dedicated test playlist, never against the user's curated playlists.
- Positions in JSON are **0-based** (same as the API and curatune). Deliberate exception: what the model
  sees and sends through tools uses `number`, **1-based** as in the Spotify app (a 9B model confused
  0-based positions with track numbers in the evaluation, `docs/evaluation.md`). Convert only at the tool
  boundary (`src/tools/`); `spotify/`, plans, and stored data stay 0-based.
- Before every commit, scan the files to be committed for personal data and secrets (including partial
  IDs, IP addresses, and hostnames). The repo is intended to be published. The exceptions are the
  author's name as the copyright holder (`LICENSE`, `NOTICE`, the READMEs, `package.json`) and the
  repository's own URL.
