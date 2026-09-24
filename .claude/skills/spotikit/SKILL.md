---
name: spotikit
description: Work with the user's own Spotify playlists through the spotikit CLI in this repository. List and read playlists, search the catalog, create playlists, add tracks, plan and apply removals or reorders, and keep recording-date metadata. Use for any request about the user's Spotify playlists, such as curating, completing, de-duplicating, ranking, analyzing, or reordering them.
allowed-tools: PowerShell(.\.venv\Scripts\spotikit.exe auth status) PowerShell(.\.venv\Scripts\spotikit.exe playlists list *) PowerShell(.\.venv\Scripts\spotikit.exe playlist show *) PowerShell(.\.venv\Scripts\spotikit.exe search tracks *) PowerShell(.\.venv\Scripts\spotikit.exe track show *) PowerShell(.\.venv\Scripts\spotikit.exe album tracks *) PowerShell(.\.venv\Scripts\spotikit.exe recordings show *) PowerShell(.\.venv\Scripts\spotikit.exe plan show *) PowerShell(.\.venv\Scripts\spotikit.exe plan remove *) PowerShell(.\.venv\Scripts\spotikit.exe plan reorder *) Bash(.venv/bin/spotikit auth status) Bash(.venv/bin/spotikit playlists list *) Bash(.venv/bin/spotikit playlist show *) Bash(.venv/bin/spotikit search tracks *) Bash(.venv/bin/spotikit track show *) Bash(.venv/bin/spotikit album tracks *) Bash(.venv/bin/spotikit recordings show *) Bash(.venv/bin/spotikit plan show *) Bash(.venv/bin/spotikit plan remove *) Bash(.venv/bin/spotikit plan reorder *) Bash(.venv/Scripts/spotikit.exe auth status) Bash(.venv/Scripts/spotikit.exe playlists list *) Bash(.venv/Scripts/spotikit.exe playlist show *) Bash(.venv/Scripts/spotikit.exe search tracks *) Bash(.venv/Scripts/spotikit.exe track show *) Bash(.venv/Scripts/spotikit.exe album tracks *) Bash(.venv/Scripts/spotikit.exe recordings show *) Bash(.venv/Scripts/spotikit.exe plan show *) Bash(.venv/Scripts/spotikit.exe plan remove *) Bash(.venv/Scripts/spotikit.exe plan reorder *)
---

# spotikit (Claude Code entry point)

The spotikit skill is shared by every agent and lives in `.agents/skills/spotikit/SKILL.md`. Claude Code
only discovers skills under `.claude/skills/`, so this file exists to register the skill and pre-approve
its read-only commands.

**Before running any spotikit command, read `.agents/skills/spotikit/SKILL.md` in full and follow it.**
It holds the commands, workflows, confirmation rules, and error handling.
