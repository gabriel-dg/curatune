---
name: curatune
description: Work with the user's own Spotify playlists through the curatune CLI in this repository. List and read playlists, search the catalog, create playlists, add tracks, plan and apply removals or reorders, and keep recording-date metadata. Use for any request about the user's Spotify playlists, such as curating, completing, de-duplicating, ranking, analyzing, or reordering them.
allowed-tools: PowerShell(.\.venv\Scripts\curatune.exe auth status) PowerShell(.\.venv\Scripts\curatune.exe playlists list *) PowerShell(.\.venv\Scripts\curatune.exe playlist show *) PowerShell(.\.venv\Scripts\curatune.exe search tracks *) PowerShell(.\.venv\Scripts\curatune.exe track show *) PowerShell(.\.venv\Scripts\curatune.exe album tracks *) PowerShell(.\.venv\Scripts\curatune.exe recordings show *) PowerShell(.\.venv\Scripts\curatune.exe plan show *) PowerShell(.\.venv\Scripts\curatune.exe plan remove *) PowerShell(.\.venv\Scripts\curatune.exe plan reorder *) Bash(.venv/bin/curatune auth status) Bash(.venv/bin/curatune playlists list *) Bash(.venv/bin/curatune playlist show *) Bash(.venv/bin/curatune search tracks *) Bash(.venv/bin/curatune track show *) Bash(.venv/bin/curatune album tracks *) Bash(.venv/bin/curatune recordings show *) Bash(.venv/bin/curatune plan show *) Bash(.venv/bin/curatune plan remove *) Bash(.venv/bin/curatune plan reorder *) Bash(.venv/Scripts/curatune.exe auth status) Bash(.venv/Scripts/curatune.exe playlists list *) Bash(.venv/Scripts/curatune.exe playlist show *) Bash(.venv/Scripts/curatune.exe search tracks *) Bash(.venv/Scripts/curatune.exe track show *) Bash(.venv/Scripts/curatune.exe album tracks *) Bash(.venv/Scripts/curatune.exe recordings show *) Bash(.venv/Scripts/curatune.exe plan show *) Bash(.venv/Scripts/curatune.exe plan remove *) Bash(.venv/Scripts/curatune.exe plan reorder *)
---

# curatune (Claude Code entry point)

The curatune skill is shared by every agent and lives in `.agents/skills/curatune/SKILL.md`. Claude Code
only discovers skills under `.claude/skills/`, so this file exists to register the skill and pre-approve
its read-only commands.

**Before running any curatune command, read `.agents/skills/curatune/SKILL.md` in full and follow it.**
It holds the commands, workflows, confirmation rules, and error handling.
