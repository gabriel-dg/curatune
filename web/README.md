# curatune-web — curate your playlists in the browser (for Spotify)

curatune-web is not affiliated with, endorsed by, or sponsored by Spotify. Spotify is a trademark of Spotify
AB. The Spotify logo in `public/brand/` is Spotify AB's trademark, used for attribution as Spotify's
Branding Guidelines require, and is not covered by this project's license.

Curate your own Spotify playlists by chatting in the browser. You ask in plain language ("are there
duplicates in X?", "sort X by recording date", "create a playlist with…"); an LLM chooses the operations,
and they run in your browser with your own Spotify token, which goes to no server but Spotify's.

It is the browser side of [curatune](../README.md): the same rules as the Python CLI and MCP server in
[`../api/`](../api/), ported to TypeScript.

## What it does

- Your playlists in a sidebar, the chat in the middle, and a panel for the playlist on screen (its tracks
  and recording dates) or for everything changed in the session.
- Reads playlists and the catalog, creates playlists, and adds tracks; each write shows as a card in the
  chat. Adding tracks to a playlist the app didn't create in this session first shows you the tracks with
  **Confirm** and **Cancel**, and waits for your click.
- Removals, reorders, renames, and description changes come as **plans**: the chat shows the change, and
  only your click on **Apply** runs it. The model has no tool to apply a plan.
- Keeps recording dates in the browser, with source and confidence, to sort playlists chronologically.

## Which model sees what

- **A local model is the default**, in every new tab: an OpenAI-compatible server you run, such as LM
  Studio or Ollama. Your playlist data stays on your own computers.
- **A hosted model, such as Gemini, is optional**, chosen in the chat. While one is selected, your messages
  and the playlist data the assistant reads (playlist names, track names, and artists) leave your computer
  for that provider, and the chat shows a notice saying so, citing Spotify's Developer Terms (IV.2.1) and
  Developer Policy (III.14) on AI models. Its API key is pasted in the app and kept only in that browser
  tab.
- No model ever receives your Spotify token.

Your Spotify token is kept in the tab's `sessionStorage`. Closing the tab doesn't reliably remove it
(reopening a closed tab, session restore, or duplicating the tab brings it back), so use **Log out** when
you're done. Log out only removes the copy in the browser; to revoke the app's access completely, remove it
at https://www.spotify.com/account/apps.

## Setup

Follow [the web app's section](../README.md#4-the-web-app-web) of the main README. In short: a Spotify app
whose redirect URIs include `http://127.0.0.1:5173/callback`, an LLM server with CORS enabled and a model
loaded with a context length of at least 32768 tokens, and `.env.local` filled in from `.env.example`.

## Development

Requires Node 22 or newer.

```bash
npm ci
cp .env.example .env.local   # then fill in VITE_SPOTIFY_CLIENT_ID, VITE_LLM_BASE_URL, VITE_LLM_MODEL
npm run dev                  # http://127.0.0.1:5173 (use 127.0.0.1, not localhost)
npm test
npm run build                # typecheck + static build in dist/
npm run eval                 # evaluate models against the in-memory Spotify
```

LM Studio loads models on demand with a 4096-token context unless the model's default is changed; the
app stops with `LLM_CONTEXT_EXCEEDED` when a conversation outgrows it. How models were evaluated, and the
results, are in [docs/evaluation.md](docs/evaluation.md). Development rules for coding agents, including
the security invariants, are in [AGENTS.md](AGENTS.md).

## Building for GitHub Pages

The build is a static site. `VITE_BASE_PATH` (read at build time, default `/`) sets the path it is served
under; the OAuth redirect URI is the site's origin, that path, and `callback`. Pages has no SPA fallback,
so the build also writes `dist/callback.html`, a copy of `index.html` that Pages serves for `/callback`
without a redirect (the query string stays intact).

| Site | Build | Redirect URI to register in Spotify |
|---|---|---|
| At the root of its origin | `npm run build` | `https://curatune.github.io/callback` |
| Under a project path | `VITE_BASE_PATH=/curatune/ npm run build` | `https://<user>.github.io/curatune/callback` |

In PowerShell, set the variable first: `$env:VITE_BASE_PATH='/curatune/'; npm run build`. Set it only for
builds, not in `.env.local`: it moves the dev server too. The development redirect URI is unchanged,
`http://127.0.0.1:5173/callback`. The other `VITE_*` variables are baked into the build as well, and the
LLM endpoint's origin must be reachable from the browser that opens the site (CSP `connect-src` and CORS).

**Status:** an early single-user prototype, with no demo mode and no remote access yet.

## License

MIT © 2026 Gabriel de Giuli. See [LICENSE](../LICENSE). The Spotify logo in `public/brand/` is a trademark
of Spotify AB and is not covered by it ([NOTICE](../NOTICE)).
