# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's private vulnerability reporting: on this
repository's **Security** tab, choose **Report a vulnerability**
(<https://github.com/gabriel-dg/curatune/security/advisories/new>). Please don't open a public issue for
a vulnerability.

Include what you found, how to reproduce it, and what it affects (`api/`, `web/`, or both). curatune is a
personal project: every report is read, but there is no guaranteed response time.

## What matters most

- The Spotify token leaving the browser (`web/`) or your machine (`api/`), or reaching the model.
- A way for the model, or for text in a playlist, to apply a plan without the person's confirmation.
- The MCP server's confirmation page or its one-time codes being reachable or guessable by anything but
  the person confirming.

Outside the scope: an agent with shell access on your machine acting on purpose (see
[api/docs/design.md](api/docs/design.md#threats-and-security-properties)), and the security of Spotify's
API or of the LLM server you run.

## Supported versions

Only the latest commit on `main`.
