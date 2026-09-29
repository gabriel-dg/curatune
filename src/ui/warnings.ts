// Warnings as the user reads them. Reads and plans return warnings for the model and for spotikit parity;
// some are bookkeeping the app already handled and mean nothing to the user, the rest get plain wording.
// Track numbers are 1-based, as in the Spotify app. Pure (no DOM), so it is tested in Node.

import type { Warning } from "../spotify/playlists";

/** Handled by the app itself; nothing for the user to do or know. */
const INTERNAL = new Set(["SNAPSHOT_READ_LAG"]);

/** "track 3" or "tracks 3, 7", or null when the warning names no positions. */
function tracks(w: Warning): string | null {
  const positions = Array.isArray(w.positions) ? (w.positions as number[]) : [];
  if (!positions.length) return null;
  return `track${positions.length === 1 ? "" : "s"} ${positions.map((p) => p + 1).join(", ")}`;
}

export function userWarning(w: Warning): string | null {
  if (INTERNAL.has(w.code)) return null;
  const list = tracks(w);
  switch (w.code) {
    case "LOCAL_FILES":
      return `Local files, not on Spotify${list ? `: ${list}` : ""}.`;
    case "UNAVAILABLE_ITEMS":
      return `No longer available on Spotify${list ? `: ${list}` : ""}.`;
    case "REINSERTED_DUPLICATES":
      return "Kept copies of duplicated tracks are removed and added back, so their date added resets.";
    default:
      return list ? `${w.message} (${list})` : w.message;
  }
}

export function userWarnings(warnings: Warning[]): string[] {
  return warnings.map(userWarning).filter((w): w is string => w !== null);
}
