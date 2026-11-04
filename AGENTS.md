# curatune — instructions for coding agents

Two projects, each with its own instructions. Read the ones for the folder you work in:

- [`api/AGENTS.md`](api/AGENTS.md): the Python library, CLI, and MCP server (the specification).
- [`web/AGENTS.md`](web/AGENTS.md): the browser app, a port of `api/` whose modules cite, in a header
  comment, the `api/` commit they follow.

For the whole repository:

- Everything in the repository (code, comments, identifiers, docs, commit messages) is in English.
- The repository is public. Never put personal data (user IDs, playlist IDs, names, emails, IP addresses,
  hostnames, local paths) or secrets in versioned files, and scan what you commit for them. Personal
  context goes in gitignored `AGENTS.local.md` files. The deliberate exceptions are the author's name,
  Gabriel de Giuli, as the copyright holder in `LICENSE`, `NOTICE`, the READMEs, and the package metadata,
  and the repository's own URL (`https://github.com/gabriel-dg/curatune`) in the docs, `SECURITY.md`, and
  the package metadata.
- A change to shared behaviour starts in `api/` and is then ported to `web/`; facts verified about the
  Spotify Web API go in `api/docs/reference.md` ("Spotify API notes") and in `web/AGENTS.md`.
- CI (`.github/workflows/tests.yml`) runs on pushes to `main` and on pull requests: `api/` on Windows and
  Linux, Python 3.10 and 3.14, with and without the `mcp` extra; `web/` on Node 22.
