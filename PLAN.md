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
| v1 scope | No web search. Recording dates: added after phase 4 (a local store, as in spotikit) |

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

## After phase 4 — first use by the operator (2026-09-28)

- A real request ("create a playlist with 20 underrated 60s songs in chronological order, one per artist")
  hit the step limit: one search per call, a cap of 8 calls per step, and the model trying to confirm
  recording years through `released` (edition dates) and re-searching.
- Fixes: `search_many` (up to 25 searches per call, 4 concurrent, like spotikit's batch search, which had
  not been ported); the prompt says to search each song once and to order by the original year from the
  model's knowledge, never by `released`; the step limit is 12, and reaching it asks the model (without
  tools) for a summary of what it did instead of discarding the turn.
- Evaluation with `search_many` (Ornith, 2 runs): search, create with tracks, and add all 2/2; a new
  "create in chronological order" scenario 0/2. The mechanics work (one `search_many`, one create, one
  add), but the 9B model gets recording years wrong with confidence (e.g. "Swing to Bop, 1931") and took
  10-15 minutes on that request.
- Conclusion: the deterministic layer matches spotikit; the gap is the model's knowledge. spotikit relies on
  Claude (and web search) for recording dates and stores them (`recordings set`), then sorts in code.
  Candidates: a stronger hosted model for knowledge-heavy requests, and porting the recording-date store.
- Comparison with the same code and scenarios (21 scenarios, 2 runs each, fake Spotify, 2026-09-29):

  | Model | Passed | Time for both runs | Per model step |
  |---|---|---|---|
  | `ornith-1.5-9b-mlx` (local, 32k context) | 40/42 | 69 min | ~30 s |
  | `gemini-3.8-flash` (hosted, Tier 1) | 42/42 | 4.3 min | ~2 s |

  Per scenario Gemini was 4-19x faster (about 65x on the chronological one: 12 s against 13 min). Ornith
  failed "create in chronological order" twice (wrong recording years); Gemini ordered it correctly both
  times, with months. One Ornith failure in the first tally was a grader false positive ("que aplique",
  subjunctive), fixed; Ornith did offer to apply a plan itself there, so the prompt now forbids that.
  The evaluation uses the fake Spotify: with the real API each Spotify call adds about 0.5-2 s.
- Hosted model comparison: `npm run eval` can target an OpenAI-compatible hosted API (`EVAL_HOSTED=1`,
  `EVAL_LLM_BASE_URL`, `EVAL_LLM_API_KEY` in `.env.local`, read only by the evaluation, never bundled).
  `gemini-3.8-flash` works (tool calls in the history included). Its free tier allows 20 requests per
  day per model, not enough for a run (70-80 requests); results above are from a Tier 1 (billed) project.

- Gemini as an optional provider in the chat (2026-09-29): a model selector next to Send (local by default),
  the API key pasted in the app and kept in the tab's sessionStorage, the provider's origin in the CSP
  (Google's endpoint allows CORS from the app's origin). The operator's original request, repeated with
  `gemini-3.8-flash`: one `search_many` with 20 searches (3.6 s), `playlist_create`, one `playlist_add` with
  20 tracks, about 10 s from creating to adding; 20 distinct, genuinely lesser-known artists, in
  chronological order by year, with plausible years.

- Recording-date store (2026-09-29), ported from spotikit's `recordings.py`: same JSON format (import and
  export on a Recordings page, so the operator's 144 curated dates can come over), IndexedDB storage,
  lookup by URI or ISRC, `recordings_show` and `recordings_set` tools, `plan_reorder` with `sort_by:
  "recorded"`, and a Recorded column in the playlist view. Gemini passed the three new scenarios twice
  (check chronology, reorder from stored dates, fill the missing dates from its knowledge without
  touching stored ones): 48/48 overall. Ornith passed checking chronology and reordering from stored dates, but not
  filling the missing dates (misspelled URIs, stopped by the known-ID guard; 16 minutes).
- UI redesign (2026-09-29): a warm dark theme with an amber accent; sidebar with the playlists (filter, All
  and Mine), the chat in the centre, and a side panel for a playlist (facts, quick actions that ask the
  chat, filter, sortable columns), the recording dates, or the session's activity. The playlist on screen
  becomes the chat's context. Answers render a safe Markdown subset (links only to open.spotify.com); tool
  calls show as compact steps; plans show as diffs (removed tracks struck through; for reorders, only the
  tracks the operations carry count as moved). Found while testing: a database version upgrade could
  block forever when another tab ran the old version (blank page); now tabs yield on versionchange and
  the app falls back to memory with a warning after 3 s.
- UI refinements (2026-09-29): loading feedback when opening a playlist (a spinner on its sidebar row, a
  skeleton panel, a loading bar); the suggestions presented as examples, pointing to free text; the
  compensated `SNAPSHOT_READ_LAG` hidden from the UI and the other warnings worded plainly.
- Playlist covers (2026-09-29) in the sidebar and the panel header, from the `images` that `/me/playlists`
  and the playlist read already return (no extra API calls); the initial letter as fallback. Measured in
  the browser on the operator's account (28 playlists, 1x display, 6 reloads each): the list appears
  after about 1.05 s with and without covers, since the wait is Spotify's response. Covers with a cold
  cache: 28 requests, about 325 KB (uploaded covers about 28 KB each; mosaics offered in 60/300/640 px, the
  60 px one about 2.3 KB), all shown about 1.1 s after the list; with a warm cache, 0-0.35 s after. On a
  2x display the browser picks the 300 px mosaics (about 25 KB each).
- Resizable columns (2026-09-29): drag the edge of the playlists column or of the panel (the chat takes the
  rest, never under 420 px beside the panel), double-click to reset, arrow keys on a focused edge.
  Widths are remembered in localStorage (two numbers; the only use of it, checked by the invariants).
- More models (2026-09-29), same code and fake Spotify:
  - `qwen3.8-27b` (local, GGUF IQ4_XS, 15.2 GB) loads with 32768 context on the operator's 24 GB Mac (the
    MLX build was clamped to 4096). On 10 scenarios (1 run) it passed the 8 mechanical ones, about 1.6x
    slower than Ornith (~38 s per step against ~23 s); on the two knowledge-heavy ones a single step took
    over 300 s, so Node's fetch cut it (reported as `LLM_UNREACHABLE`; the app's own timeout is 300 s too).
    Not an improvement on this machine.
  - `gemini-3.5-flash-lite` (the newest Flash Lite; there is no 3.6-3.8 Lite for text): 44/48 on the full
    set (2 runs), about 1.1 s per step against 2.3 s for 3.8 Flash. It failed "create in chronological
    order" twice (Boplicity after Un Poco Loco; once Lady Bird before Manteca) and "create with tracks"
    twice (a misspelled playlist name, an empty final answer). Two more failures were a grader false
    negative: `plan_reorder` with `sort_by: "title"` reads the playlist itself, so `playlist_show` is no
    longer required there.

  | Model | Where | Passed | Per model step | Recording years |
  |---|---|---|---|---|
  | `gemini-3.8-flash` | hosted | 48/48 | ~2.3 s | right, with months |
  | `gemini-3.5-flash-lite` | hosted | 44/48 | ~1.1 s | close, but misorders |
  | `ornith-1.5-9b-mlx` | local, 9.5 GB | 40/42 (21 scenarios) | ~23-30 s | wrong, with confidence |
  | `qwen3.8-27b` (GGUF) | local, 15.2 GB | 8/10 (subset) | ~38 s | steps over 300 s |

- Model selector (2026-09-29): `VITE_HOSTED_LLM_MODEL` takes a comma-separated list, each model in the
  chat's selector with one shared API key, so the operator picks per task: Flash Lite for mechanical
  work, 3.8 Flash for anything that depends on knowledge, the local model to keep everything on the LAN.

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
