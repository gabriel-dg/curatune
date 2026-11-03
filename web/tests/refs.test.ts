import { describe, expect, it } from "vitest";
import { parseId, toUri } from "../src/spotify/refs";

const ID = "0123456789abcdefABCDEF";

describe("parseId", () => {
  it.each([
    ID,
    `  ${ID}  `,
    `spotify:playlist:${ID}`,
    `https://open.spotify.com/playlist/${ID}`,
    `https://open.spotify.com/playlist/${ID}?si=abc`,
    `https://open.spotify.com/intl-es/playlist/${ID}`,
  ])("parses %s", (ref) => {
    expect(parseId(ref, "playlist")).toBe(ID);
  });

  it.each([
    `spotify:track:${ID}`,
    `spotify:playlist:${ID}:extra`,
    `https://open.spotify.com/track/${ID}`,
    `https://evil.example/playlist/${ID}`,
    `https://open.spotify.com.evil.example/playlist/${ID}`,
    "short",
    `${ID}x`,
    "",
  ])("rejects %s", (ref) => {
    expect(() => parseId(ref, "playlist")).toThrowError(expect.objectContaining({ code: "INVALID_REFERENCE" }));
  });

  it("builds URIs", () => {
    expect(toUri("track", ID)).toBe(`spotify:track:${ID}`);
  });
});
