import { describe, expect, it } from "vitest";
import { ENTRY_TTL_MS } from "../src/spotify/writelog";
import { countToShow } from "../src/ui/sidebar";

describe("countToShow", () => {
  const now = 1_000_000_000;

  it("shows the list's count when nothing newer is known", () => {
    expect(countToShow(12, undefined, now)).toEqual({ count: 12, keep: false });
    expect(countToShow(null, undefined, now)).toEqual({ count: null, keep: false });
  });

  it("keeps a recent write's count while Spotify's list still returns the old total", () => {
    // A playlist created and filled with 20 tracks; the list still says 0.
    expect(countToShow(0, { count: 20, at: now - 60_000 }, now)).toEqual({ count: 20, keep: true });
  });

  it("drops the known count once the list agrees", () => {
    expect(countToShow(20, { count: 20, at: now - 60_000 }, now)).toEqual({ count: 20, keep: false });
  });

  it("trusts the list again after the write log's lifetime", () => {
    expect(countToShow(0, { count: 20, at: now - ENTRY_TTL_MS - 1 }, now)).toEqual({ count: 0, keep: false });
  });
});
