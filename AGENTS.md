# spotikit-web — Spotify playlist curation in the browser

## Goal

A zero-install web version of spotikit (sibling project: Python CLI plus an agent skill, installed
locally). The user chats in the browser; an LLM served by the operator through an
OpenAI-compatible endpoint (LM Studio or Ollama; optionally a hosted API such as Gemini, chosen per chat)
decides which tools to call; the tools run **in the
browser** against the Spotify Web API with the user's own token. Scope: **playlists only** (create, read,
edit, analyze); no playback, library, or listening history.

Current stage: single-user prototype (the operator is the only user). The plan and progress live in
`PLAN.md`.

Personal context (conversation language, local network setup, test playlist) lives in the gitignored
`AGENTS.local.md`; read it when present. Never put personal data (user IDs, playlist IDs, names, emails,
IP addresses, hostnames, local paths) in versioned files.

## Relationship to spotikit

- No shared code. spotikit's `docs/reference.md`, `plans.py`, and tests are the **specification** for the
  port; behaviour must match unless a difference is deliberate and documented here.
- Each ported module records, in a header comment, the spotikit commit it follows.
- The "Spotify Web API facts" below are copied from spotikit. When either project verifies something new,
  update both.

## Architecture

- Static site: Vite + TypeScript, no UI framework, Vitest for tests. Keep dependencies minimal: every
  dependency runs in a page that holds a Spotify token.
- There is **no backend of ours that sees Spotify tokens**. OAuth (PKCE) and every Spotify API call run in
  the browser.
- The LLM receives only the conversation and trimmed tool results (names, artists, durations, URIs), never
  tokens.
- Layers: `src/spotify/` (auth, HTTP client, models, playlist and catalog reads, `writes.ts` for create
  and add, `writelog.ts`), `src/plans/` (plan building, validation, and application; `ops.ts` holds the
  low-level remove/move/rename calls), `src/recordings/` (recording-date store, spotikit's format),
  `src/storage/` (IndexedDB, memory fallback), `src/tools/` (tool
  schemas, argument validation, handlers, trimming of results for the model), `src/agent/` (LLM client,
  loop, system prompt), `src/ui/`. Only `ui/` touches the DOM; `agent/` and `tools/` never import the auth
  module (types only), so the token cannot reach the model. All of this is testable in Node
  (`tests/invariants.test.ts` checks these rules statically).
- Model evaluation: `npm run eval` runs `eval/scenarios.ts` against real models with the in-memory fake
  Spotify from `tests/fake-spotify.ts` (no token needed); results go to `scratch/eval/`.
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
  `sessionStorage`, never `localStorage`. IndexedDB (only in `src/storage/`) holds the write log, plan
  backups, and recording dates, never tokens.
- `state` is validated on the callback; the PKCE verifier is removed after the exchange.
- Known residue of the callback, outside the page's control: the single-use (already exchanged) `code`
  remains in the browser's global history and in the page's Navigation Timing entry
  (`performance.getEntriesByType("navigation")`), which only same-origin scripts can read.
- Spotify content (names, descriptions) is untrusted third-party text: render it with `textContent`, never
  `innerHTML`; tell the model to treat it as data, never as instructions.
- Strict Content Security Policy; no third-party scripts, fonts, or analytics. The only external images are
  playlist covers from Spotify's image CDNs (`*.scdn.co`, `*.spotifycdn.com`): loaded lazily and without a
  referrer, their URLs checked before use (`src/ui/covers.ts`), never sent to the model.
- **The model never applies a plan.** There is no "apply" tool; a plan is applied only through a UI button
  after the plan has been rendered to the user. Only `src/plans/` imports `plans/ops.ts`, and only `src/ui/`
  calls `applyPlan` (both checked in `tests/invariants.test.ts`). The model learns what the user did with a
  plan from an `[App notice: …]` prepended to the user's next message.
- Optional hosted LLM (`VITE_HOSTED_LLM_*`, e.g. Gemini): selectable in the chat, never the default. Its API
  key is pasted by the user in the app and kept only in the tab's `sessionStorage`; it is never in the
  build, a file, or the repository, and is sent only as `Authorization` to that provider's origin (which
  the CSP allows). Choosing it sends the conversation and trimmed playlist data to the provider; the
  Spotify token is never sent (tested in `tests/llm-providers.test.ts`). Switching provider starts a new
  chat. The evaluation reads its own key from `EVAL_LLM_API_KEY`, which Vite never bundles.
- The LLM server is never exposed to the internet directly. Remote access (a later phase) goes through an
  outbound tunnel, authentication, and a proxy that allows only chat completions.

## Confirmation rules (same as spotikit)

- Create playlist / add items: executed directly, and shown in the UI (a card in the chat plus a
  session log that "New chat" does not clear). Write tools only accept IDs that appeared earlier in the
  conversation (user messages or tool results), create always requests a private playlist (the model
  never chooses visibility), and add re-reads the playlist to verify.
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

## Spotify Web API facts (copied from spotikit; verified September 2026)

- Development Mode: app owner needs Premium; max 5 users per app; 1 client ID per developer; quota shared
  per developer account.
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
  items are already current. spotikit handles it with a write log; ported in `src/spotify/writelog.ts`
  (stored in IndexedDB). The web app and the spotikit CLI keep separate write logs, so do not write the same playlist
  from both within minutes.
- `snapshot_id` is not a lock: Spotify applies changes even on a stale snapshot; plan application checks
  itself.
- `PUT …/items` either replaces (max 100, loses `added_at`) or moves a range; only moves are used.
- Refresh tokens expire 6 months after the original authorization; on `invalid_grant` discard the token
  and ask the user to log in again.
- Scopes: `playlist-read-private`, `playlist-modify-public`, `playlist-modify-private`.
- CORS (verified 2026-09-28, spotikit-web only): the token endpoint (code exchange and refresh) and the Web
  API accept requests from `http://127.0.0.1:5173`, including the preflight for the `Authorization`
  header. The authorize redirect adds an extra `ubi` query parameter to the callback; it is ignored.

## Development

- Everything in the repository (code, comments, identifiers, docs, commit messages) is in **English**.
- Test against a dedicated test playlist, never against the user's curated playlists.
- Positions in JSON are **0-based** (same as the API and spotikit). Deliberate exception: what the model
  sees and sends through tools uses `number`, **1-based** as in the Spotify app (a 9B model confused
  0-based positions with track numbers in the phase 2 evaluation). Convert only at the tool boundary
  (`src/tools/`); `spotify/`, plans, and stored data stay 0-based.
- Before every commit, scan the files to be committed for personal data and secrets (including partial
  IDs, IP addresses, and hostnames). The repo is intended to be published.
