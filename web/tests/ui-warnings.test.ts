import { describe, expect, it } from "vitest";
import { userWarning, userWarnings } from "../src/ui/warnings";

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
