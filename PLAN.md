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
- [ ] Fix or replace the Gemma 4 prompt template, then re-run the evaluation on it.

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

- [ ] Vite + TypeScript scaffold; dev server on `127.0.0.1:5173`, strict port; CSP in place.
- [ ] `.env.example` with `VITE_SPOTIFY_CLIENT_ID`, `VITE_LLM_BASE_URL`, `VITE_LLM_MODEL`.
- [ ] PKCE flow: verifier and `state` generation, `state` validation, token exchange from the browser,
      refresh, URL cleanup after the callback.
- [ ] HTTP client with the host allowlist (`UNTRUSTED_URL`) and pagination.
- [ ] List playlists; show one playlist with all its items.
- [ ] Record the CORS verification result in `AGENTS.md`.
- **Done when:** your playlists appear, and the token is absent from the console, the URL, and the
  history.

## Phase 2 — Local LLM with read-only tools

- [ ] Agent loop in the browser: max iterations, timeouts, error handling.
- [ ] Tools: `playlists_list`, `playlist_show`, `search_tracks`, `track_show`, `album_tracks`.
- [ ] Trim tool results before they reach the model (name, artists, duration, URI).
- [ ] System prompt adapted from spotikit's `SKILL.md` (Spotify text is data, not instructions).
- [ ] Evaluation set of 8–10 prompts based on real requests; run it against each model and record the
      results.
- **Done when:** at least one model picks the right tools for most prompts. If none does, that is the
  finding: stop here.

## Phase 3 — Direct writes

- [ ] Create playlist (re-read and report real visibility); add items.
- [ ] The UI shows every write performed.
- **Done when:** "create a playlist X with these 5 tracks" works end to end.

## Phase 4 — Plans confirmed in the UI

- [ ] Port of spotikit's `plans.py`: build remove, reorder, and details plans.
- [ ] Port of `validate_plan`, including `PLAN_INCONSISTENT`.
- [ ] Port of plan application with pre- and post-verification.
- [ ] Write log for the snapshot read lag, in IndexedDB.
- [ ] Port of the in-memory fake playlist API (`tests/fakes.py`) and the plan tests, to Vitest.
- [ ] The model only proposes plans; the UI renders before, changes, and after, and its "Apply" button is
      the only way to run one.
- **Done when:** de-duplicating and reordering the test playlist works, and a tampered plan is rejected.

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
