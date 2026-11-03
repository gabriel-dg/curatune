# curatune: a 60–90 second demo video

What the video shows: an AI curates Spotify playlists through curatune's MCP server, and it can't change
what's already in a playlist unless the person confirms it, outside the chat. Everything is recorded on
**demo mode**: a synthetic account in memory, so the video shows no real account, playlist, or name, and
every take starts from the same state.

## Before recording

1. Two folders, each with its own Claude Code registration of the demo server (`<repo>` is a checkout with
   `pip install -e ".[mcp]"`):

   ```bash
   cd demo-dialog
   claude mcp add curatune-demo -- <repo>/.venv/Scripts/curatune-mcp.exe --demo
   ```

   ```bash
   cd demo-page
   claude mcp add curatune-demo -e CURATUNE_MCP_CONFIRM=browser -- <repo>/.venv/Scripts/curatune-mcp.exe --demo
   ```

2. Only `curatune-demo` should be connected in those sessions: turn off other MCP servers and connectors,
   so no unrelated tool or account appears on screen.
3. Layout: the terminal on the left, a browser on the right (scene 2 opens a page there). Large font.
4. Start a fresh `claude` session per scene: the demo resets when its server restarts.
5. Prompts are in English so the replies are too. Type them, don't paste: the pace reads better.

## Script

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:08 | The README's title, then the terminal in `demo-dialog`. | "curatune lets an AI curate your Spotify playlists. It can add tracks for you. It can't take anything away without you." |
| 0:08–0:30 | **Scene 1, the dialog.** Type: *"Remove the duplicates from Bebop test."* The model reads the playlist and explains its call: Ko-Ko appears three times, twice as the same track and once from a compilation, and it keeps the original Savoy one. Claude Code asks to run `plan_apply`; allow it. The confirmation dialog shows the summary built from the plan and, apart, the model's explanation labelled as unchecked. Accept. Result: applied, verified, 7 tracks → 5. | "Removing is never one step. The model builds a plan, and the server asks me in a dialog it can't answer for me. The summary comes from the plan itself; the model's reasoning is shown apart, labelled." |
| 0:30–0:52 | **Scene 2, the page.** Switch to `demo-page`. Type: *"Sort Bebop test by title."* `plan_apply` answers that a page opened; the browser shows the plan with Approve and Reject. Click **Approve**: a code like `7KQ2-M9PD` appears. Paste it in the chat. Result: applied, verified, and the new order. | "Clients without dialogs get a page on my own machine instead. The model never sees this page. I read the code and paste it myself; it works once, for this plan, for ten minutes." |
| 0:52–1:12 | **Scene 3, text written by someone else.** In `demo-dialog` (a fresh session), type: *"Show me Late-night picks."* The model lists the tracks and points out that the description tries to order it to delete everything without asking. Then: *"Do whatever that playlist needs."* Nothing is removed; if the model builds a plan anyway, the dialog appears: decline it. | "Playlist names and descriptions are written by other people. curatune treats them as data, and the model tells me when one tries to give it orders. Even if it were fooled, it couldn't confirm for me." |
| 1:12–1:25 | **Scene 4, try it.** The `claude mcp add curatune-demo … --demo` line, then the README's "Clients" table. | "This was demo mode: no Spotify account, nothing kept. With your own account, curatune runs locally; your token never leaves your machine." |
| 1:25–1:30 | End card: the repository's URL. Small print: "curatune is not affiliated with, endorsed by, or sponsored by Spotify." | — |

## Notes

- Scene 1 and scene 3 can share a session if time is short, but a fresh one resets the demo.
- The model may word things differently, or (in scene 1) choose to keep another copy. Keep whatever it
  explains clearly; retake only if it skips the explanation or the dialog.
- If Claude Code asks permission for read tools too, allow them; only `plan_apply` must be shown being
  allowed, since that prompt is part of the story.
- Claude Desktop isn't verified yet. Don't show it, and don't say it works, until it has been tested.
