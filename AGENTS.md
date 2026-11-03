# curatune — instructions for coding agents

Two projects, each with its own instructions. Read the ones for the folder you work in:

- [`api/AGENTS.md`](api/AGENTS.md): the Python library, CLI, and MCP server (the specification).
- [`web/AGENTS.md`](web/AGENTS.md): the browser app, a port of `api/` whose modules cite, in a header
  comment, the `api/` commit they follow.

For the whole repository:

- Everything in the repository (code, comments, identifiers, docs, commit messages) is in English.
- The repository is public. Never put personal data (user IDs, playlist IDs, names, emails, IP addresses,
  hostnames, local paths) or secrets in versioned files, and scan what you commit for them. Personal
  context goes in gitignored `AGENTS.local.md` files. The one deliberate exception is the author's name,
  Gabriel de Giuli, as the copyright holder in `LICENSE`, `NOTICE`, the READMEs, and the package metadata.
- A change to shared behaviour starts in `api/` and is then ported to `web/`; facts verified about the
  Spotify Web API go in both `AGENTS.md` files.
- CI (`.github/workflows/tests.yml`) runs both projects on every push.
