# spotikit-web

Curate your own Spotify playlists by chatting in the browser. An LLM served through an OpenAI-compatible
endpoint (LM Studio or Ollama) chooses the operations; they run in your browser with your own Spotify
token, which never reaches any server but Spotify's.

A zero-install sibling of spotikit, the Python CLI and agent skill.

**Status:** early single-user prototype. See [PLAN.md](PLAN.md).

## Development

Requires Node 22+ and a Spotify app whose redirect URIs include `http://127.0.0.1:5173/callback`.

```bash
npm install
cp .env.example .env.local   # then fill in VITE_SPOTIFY_CLIENT_ID
npm run dev                  # http://127.0.0.1:5173 (use 127.0.0.1, not localhost)
npm test
npm run build                # typecheck + static build in dist/
npm run eval                 # model evaluation against VITE_LLM_MODEL (EVAL_MODELS=a,b EVAL_RUNS=n)
```

The chat needs `VITE_LLM_BASE_URL` and `VITE_LLM_MODEL`, and the model loaded with a context length of at
least 32768 tokens (LM Studio loads models on demand with 4096 unless the model's default is changed).
