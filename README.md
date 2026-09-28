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
```
