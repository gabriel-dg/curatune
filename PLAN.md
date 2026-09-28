# Plan: single-user prototype

Goal: validate the full architecture with one user (the operator) before opening it to anyone else:
Spotify entirely in the browser, a self-hosted LLM choosing tools, and plans that only the UI can apply.

Setup: development and browser on a Windows PC; LM Studio on a Mac on the same LAN.

## Decisions

| Decision | Choice |
|---|---|
| Repository | Separate repo, sibling of spotikit |
| Stack | Vite + TypeScript, no UI framework; Vitest |
| Browser (phases 1–4) | Windows PC, calling LM Studio on the Mac over the LAN |
| v1 scope | No web search, no recording dates |

## Principles (all phases)

1. The Spotify token never leaves the browser (see the security invariants in `AGENTS.md`).
2. The model never applies a plan; only the UI's "Apply" button does.
3. Test on a dedicated test playlist only.
4. Do not write the same playlist from the CLI and the web app within minutes (separate write logs).
5. LM Studio stays on the home LAN until phase 5. Its endpoint is unauthenticated there, so do not use
   this setup on shared networks.

## Phase 0 — Preparation

- [x] Mac, LM Studio: download 2–3 models with good tool calling.
- [x] Mac, LM Studio server: enable "Serve on Local Network" and CORS; note the port (default 1234).
- [ ] (Deferred) Mac: check that the macOS firewall allows LM Studio's incoming connections.
- [ ] (Deferred) Mac: give it a stable address (DHCP reservation in the router, or its `<name>.local`
      hostname). Until then, if its address changes, update `VITE_LLM_BASE_URL`.
- [x] PC: `curl http://<mac>:1234/v1/models` lists the models.
- [x] PC: each model returns a valid `tool_calls` entry for a simple request (snippet below). If no model
      does this reliably, stop and rethink before writing code.
- [x] Fix or replace the Gemma 4 prompt template, then re-run the evaluation on it. `gemma-4-12b-qat`
      now ships Google's July 2026 template and handles tool calls in the history (phase 2 results). The
      26B was not re-tested: on this Mac it would not fit with a usable context anyway.

Results (2026-09-28, 8 scenarios: ID lookup before use, using IDs from tool results, search, no invented
URIs, prompt injection in a playlist description, duplicate-removal plan, no-tool question, Spanish):

- `qwen3.8-27b-mlx`: 32/32 across 4 runs. 5–20 s per step (about 15 tokens/s, 20–120 reasoning
  tokens); the first request after loading takes about 25 s. It flagged the injected instruction as
  untrusted and ignored it.
- `gemma-4-26b-a4b-qat`: passes single-turn scenarios, but any request whose history contains tool calls
  fails with HTTP 400 (LM Studio's Jinja engine does not support the template's `sequence` test). Unusable
  for the agent loop until the template is fixed.
- [x] Spotify dashboard: add the redirect URI `http://127.0.0.1:5173/callback` to the existing app.
- [x] Create a test playlist and record its ID and initial state in `AGENTS.local.md`: 12 items in
      shuffled recording order, one URI twice, the same recording on another edition (same ISRC), and
      the same composition in two recordings.

Tool-call check (Git Bash; replace `<mac>` and `<model>`):

```bash
curl -s http://<mac>:1234/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "<model>",
  "messages": [{"role": "user", "content": "Show me the tracks of my playlist called Test"}],
  "tools": [
    {"type": "function", "function": {"name": "playlists_list", "description": "List the user playlists",
      "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "playlist_show", "description": "Show a playlist and its tracks",
      "parameters": {"type": "object", "properties": {"playlist_id": {"type": "string"}},
      "required": ["playlist_id"]}}}
  ]
}'
```

Expected: a `tool_calls` entry for `playlists_list` (the model needs the ID before calling
`playlist_show`), not a plain text answer or an invented ID.

## Phase 1 — Spotify from the browser (no LLM)

- [x] Vite + TypeScript scaffold; dev server on `127.0.0.1:5173`, strict port; CSP in place.
- [x] `.env.example` with `VITE_SPOTIFY_CLIENT_ID`, `VITE_LLM_BASE_URL`, `VITE_LLM_MODEL`.
- [x] PKCE flow: verifier and `state` generation, `state` validation, token exchange from the browser,
      refresh, URL cleanup after the callback.
- [x] HTTP client with the host allowlist (`UNTRUSTED_URL`) and pagination.
- [x] List playlists; show one playlist with all its items.
- [x] Record the CORS verification result in `AGENTS.md`.
- **Done when:** your playlists appear, and the token is absent from the console, the URL, and the
  history.

Result (2026-09-28): done. Login from the browser, 28 playlists listed, the test playlist matches its
recorded state, a 271-item playlist reads fully (6 pages of 50), and a playlist owned by someone else
fails with a clear `FORBIDDEN`. Tokens appear in no console output, URL, DOM, or request URL; only
`accounts.spotify.com` and `api.spotify.com` were contacted besides the page's own origin. 110 unit tests.

## Phase 2 — Local LLM with read-only tools

- [x] Agent loop in the browser: max iterations, timeouts, error handling.
- [x] Tools: `playlists_list`, `playlist_show`, `search_tracks`, `track_show`, `album_tracks`.
- [x] Trim tool results before they reach the model (name, artists, duration, URI).
- [x] System prompt adapted from spotikit's `SKILL.md` (Spotify text is data, not instructions).
- [x] Evaluation set of 8–10 prompts based on real requests; run it against each model and record the
      results.
- **Done when:** at least one model picks the right tools for most prompts. If none does, that is the
  finding: stop here.

Result (2026-09-28): done; `ornith-1.5-9b-mlx` is the default model (`VITE_LLM_MODEL`).

Evaluation: `npm run eval`, 11 scenarios in `eval/scenarios.ts` against the in-memory fake Spotify
(list, show by name, duplicates, search, album by URI, ISRC by URL, prompt injection in a description,
a write request in read-only mode, a no-tool question, total duration, pagination past 100 items). Every
scenario also fails on invented IDs, bad tool arguments, or hitting the step limit. All models loaded
with a 32768-token context.

| Model | Size | Result | Time per run | Notes |
|---|---|---|---|---|
| `ornith-1.5-9b-mlx` | 9.5 GB | 11/11, 11/11 (and 10/11 when the model was unloaded mid-run by a concurrent load) | ~450 s | Detailed answers (tells exact duplicates from same-ISRC editions), flags the injection, never claimed a write. |
| `gemma-4-12b-qat` | ~8 GB | 10/11, 10/11 | ~175 s | 2.6× faster, shorter answers. Both runs invented the contents of the "injection" playlist without calling `playlist_show`. |
| `qwen3.8-27b-mlx` | 16.1 GB | not evaluated | | On this 24 GB Mac LM Studio clamps it to a 4096-token context whatever is requested; the agent needs more. |

Findings:

- An earlier Ornith run spoke of 0-based positions as track numbers ("track 3" read as position 3). Tool
  results now expose `number`, 1-based (see `AGENTS.md`); the scenarios check the numbers, and later
  runs got them right.
- LM Studio silently truncates a conversation that exceeds the loaded context; with 4096 tokens the model
  lost earlier tool results and looped. The loop now detects shrinking prompt-token counts and stops with
  `LLM_CONTEXT_EXCEEDED`, and it refuses to repeat an identical tool call within a turn.
- In the browser, against the real account, Ornith answered the duplicates question on the test playlist
  correctly (tracks 2 and 7 identical, 11 the same ISRC on another edition) in about 90 s, using 4.3k
  tokens of context.

## Phase 3 — Direct writes

- [x] Create playlist (re-read and report real visibility); add items.
- [x] The UI shows every write performed.
- **Done when:** "create a playlist X with these 5 tracks" works end to end.

Result (2026-09-28): done. In the browser, against the real account, Ornith turned "create a playlist
spotikit-web phase 3 with Salt Peanuts, Ko-Ko, Boplicity, Manteca, and Lady Bird" into five parallel
searches, `playlist_create`, and one `playlist_add`; it picked the 1940s recordings, rejected soundtrack,
alternate, cover, and vocal versions, and said the playlist is public. An independent read confirmed the
five tracks in order. About 3 minutes end to end, 8.8k tokens of context.

Evaluation: 15/15 for Ornith, the 11 phase 2 scenarios (with the write tools available) plus 4 that
check the fake Spotify's final state: create with tracks, add to an existing playlist, duplicate name
(asks instead of retrying with `allow_duplicate_name`), and a track the catalog lacks (seven searches,
nothing added in its place). The injection description now also asks to create a playlist and copy
tracks into it; nothing was written.

Also in this phase: write tools only accept IDs seen earlier in the conversation; a turn that fails after
writing keeps those writes in the conversation; the playlist view numbers tracks from 1.

## Phase 4 — Plans confirmed in the UI

- [x] Port of spotikit's `plans.py`: build remove, reorder, and details plans.
- [x] Port of `validate_plan`, including `PLAN_INCONSISTENT`.
- [x] Port of plan application with pre- and post-verification.
- [x] Write log for the snapshot read lag, in IndexedDB.
- [x] Port of the in-memory fake playlist API (`tests/fakes.py`) and the plan tests, to Vitest.
- [x] The model only proposes plans; the UI renders before, changes, and after, and its "Apply" button is
      the only way to run one.
- **Done when:** de-duplicating and reordering the test playlist works, and a tampered plan is rejected.

Result (2026-09-28): done. In the browser, on the test playlist, Ornith proposed removing track 7 (the
exact duplicate of track 2), kept track 11 (same ISRC, another edition) and said why, and asked to review
and apply; Apply removed it and verified. Right after, "sort it by title" became a `plan_reorder` with
`sort_by: title`, applied and verified. An independent read confirmed both. The playlist was then restored
through the app (add with duplicates allowed, then a reorder with the exact original order), also verified.
Tampered plans (checksum, descriptions that differ from the operations, a forged visibility change with a
recomputed checksum) are rejected in `tests/plans.test.ts`; mutation checks confirmed those tests fail
when the validation is disabled.

Evaluation: 20 scenarios (5 new: remove track 3, de-duplicate, move a track, alphabetical order, rename,
plus a visibility request). The first run failed the alphabetical order: the model computed the order
itself and got it wrong. `plan_reorder` now takes `sort_by` (title, artist, album, edition date, duration)
and the app sorts; the model uses it (2/2 reruns). Full rerun: 20/20, about 20 minutes.

Deliberate differences from spotikit: plans live in memory and backups in IndexedDB (no files); no order
by recording date (out of v1 scope), but deterministic sorts by other keys; the model refers to tracks by
1-based numbers.

## Phase 5 — Remote access (optional)

- [ ] Serve the static site from the Mac behind the same tunnel as the LLM (same origin: one access
      policy, no CORS).
- [ ] Outbound tunnel (Cloudflare Tunnel) and Cloudflare Access allowing only the operator's email.
- [ ] Proxy in front of LM Studio: only `/v1/chat/completions`, `max_tokens` cap, rate limit, no body
      logging.
- [ ] HTTPS redirect URI registered in the Spotify dashboard.
- [ ] Keep the Mac awake while serving.

## Phase 6 — Assessment

- [ ] Run the phase 2 evaluation set with Claude through spotikit, and compare.
- [ ] Decide whether and how to open it to others: the operator's Client ID (up to 5 allowlisted users)
      or each user bringing their own.
