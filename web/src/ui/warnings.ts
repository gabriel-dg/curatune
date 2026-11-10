// Warnings as the user reads them. Reads and plans return warnings for the model and for curatune parity;
// some are bookkeeping the app already handled and mean nothing to the user, the rest get plain wording.
// Track numbers are 1-based, as in the Spotify app. Pure (no DOM), so it is tested in Node.

import type { Warning } from "../spotify/playlists";
import type { MigrationOutcome, MigrationReport } from "../storage/kv";

/** Handled by the app itself; nothing for the user to do or know. */
const INTERNAL = new Set(["SNAPSHOT_READ_LAG", "ITEM_COUNT_READ_LAG"]);

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

// --- The one-time move of stored data from the database's former name -----------------------------------

/** A lasting notice, and whether a "Try again" button can still help. */
export interface StorageNotice {
  text: string;
  retry: boolean;
}

// Exporting from the app reads only the new storage: what is left under the former name survives only as long
// as the browser keeps this site's data.
const KEEP_SITE_DATA = "It is still in this browser: don't clear this site's data, or it will be lost.";
const NOT_MOVED = `Data saved by the app under its former name couldn't be moved to its new storage. ${KEEP_SITE_DATA}`;
const BUSY = "Couldn't check for data saved under the app's former name yet: another Curatune tab may be using it. Reload in a moment.";
const OTHER_TABS =
  "Your saved data moved to the app's new storage, but another Curatune tab still holds the old copy open. Close the " +
  "other Curatune tabs so that it can be removed.";

const items = (n: number): string => `${n} saved item${n === 1 ? "" : "s"}`;

/** What to tell the user about the move the app tried when it opened its storage, or null if nothing. */
export function storageMoveNotice(outcome: MigrationOutcome | undefined): StorageNotice | null {
  switch (outcome) {
    case "failed":
    case "skipped":
      return { text: NOT_MOVED, retry: true };
    case "busy":
      return { text: BUSY, retry: true };
    case "delete-blocked":
      return { text: OTHER_TABS, retry: false };
    default:
      return null;
  }
}

/** What a retry did. The button goes once trying again can't change anything. */
export function storageRetryNotice(report: MigrationReport): StorageNotice {
  switch (report.outcome) {
    case "migrated":
    case "no-legacy":
      return { text: `Your saved data is now in the app's new storage${report.moved ? ` (${items(report.moved)} moved)` : ""}.`, retry: false };
    case "delete-blocked":
      return { text: OTHER_TABS, retry: false };
    case "busy":
      return { text: BUSY, retry: true };
    case "skipped":
      return {
        text:
          `${report.moved ? `Moved ${items(report.moved)}, but ${items(report.kept)}` : `${items(report.kept)}`} stayed under the former ` +
          "name, because the new storage already holds different data under the same name (recording dates are stored as one " +
          `item). ${KEEP_SITE_DATA}`,
        retry: false,
      };
    case "failed":
      return { text: `Moving the data failed again. ${KEEP_SITE_DATA}`, retry: true };
  }
}
