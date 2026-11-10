import { describe, expect, it } from "vitest";
import { storageMoveNotice, storageRetryNotice, userWarning, userWarnings } from "../src/ui/warnings";

describe("userWarnings", () => {
  it("hides the snapshot read lag the app already compensated", () => {
    const lag = { code: "SNAPSHOT_READ_LAG", message: "Spotify returned a stale snapshot_id…", read_snapshot_id: "a", effective_snapshot_id: "b" };
    expect(userWarning(lag)).toBeNull();
    expect(userWarnings([lag, { code: "LOCAL_FILES", message: "Playlist contains local files.", positions: [2] }])).toEqual(["Local files, not on Spotify: track 3."]);
  });

  it("words positions 1-based, as in the Spotify app", () => {
    expect(userWarning({ code: "UNAVAILABLE_ITEMS", message: "Some items have no track object.", positions: [0, 6] })).toBe("No longer available on Spotify: tracks 1, 7.");
  });

  it("falls back to the message, without the code", () => {
    expect(userWarning({ code: "DUPLICATE_NAME", message: "You already own another playlist with this name." })).toBe("You already own another playlist with this name.");
    expect(userWarning({ code: "SOMETHING_NEW", message: "New thing.", positions: [4] })).toBe("New thing. (track 5)");
  });
});

describe("storage move notices", () => {
  it("warns, with a retry, when the move at start failed or left data behind", () => {
    for (const outcome of ["failed", "skipped"] as const) {
      const notice = storageMoveNotice(outcome)!;
      expect(notice.retry).toBe(true);
      expect(notice.text).toContain("couldn't be moved");
      expect(notice.text).toContain("don't clear this site's data");
      expect(notice.text).not.toContain("Export");
    }
  });

  it("asks to reload in a moment, with a retry, when the storage was too busy to check", () => {
    const notice = storageMoveNotice("busy")!;
    expect(notice).toEqual({ text: expect.stringContaining("Reload in a moment") as string, retry: true });
    expect(notice.text).toMatch(/^Couldn't check for data saved under the app's former name yet/);
    expect(storageRetryNotice({ outcome: "busy", moved: 0, kept: 0 })).toEqual(notice);
  });

  it("asks to close the other tabs when they hold the old copy open, without a retry", () => {
    const notice = storageMoveNotice("delete-blocked")!;
    expect(notice.retry).toBe(false);
    expect(notice.text).toContain("Close the other Curatune tabs");
  });

  it("says nothing when there was nothing to move, or the move finished", () => {
    expect(storageMoveNotice("migrated")).toBeNull();
    expect(storageMoveNotice("no-legacy")).toBeNull();
    expect(storageMoveNotice(undefined)).toBeNull();
  });

  it("words what a retry did, and drops the button once trying again can't help", () => {
    expect(storageRetryNotice({ outcome: "migrated", moved: 4, kept: 0 })).toEqual({
      text: "Your saved data is now in the app's new storage (4 saved items moved).",
      retry: false,
    });
    const partial = storageRetryNotice({ outcome: "skipped", moved: 3, kept: 1 });
    expect(partial.retry).toBe(false);
    expect(partial.text).toMatch(/^Moved 3 saved items, but 1 saved item stayed under the former name/);
    expect(storageRetryNotice({ outcome: "skipped", moved: 0, kept: 2 }).text).toMatch(/^2 saved items stayed under the former name/);
    expect(storageRetryNotice({ outcome: "delete-blocked", moved: 4, kept: 0 })).toEqual({ text: storageMoveNotice("delete-blocked")!.text, retry: false });
    expect(partial.text).toContain("don't clear this site's data");
    const failed = storageRetryNotice({ outcome: "failed", moved: 0, kept: 0 });
    expect(failed.retry).toBe(true);
    expect(failed.text).toContain("don't clear this site's data");
  });
});
