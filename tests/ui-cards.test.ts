import { describe, expect, it } from "vitest";
import { spotifyUrl } from "../src/ui/cards";

describe("spotifyUrl", () => {
  it("links playlists, tracks, and albums back to Spotify", () => {
    expect(spotifyUrl("playlist", "37i9dQZF1DXcBWIGoYBM5M")).toBe("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M");
    expect(spotifyUrl("track", "0000000000000000000001")).toBe("https://open.spotify.com/track/0000000000000000000001");
    expect(spotifyUrl("album", "AbCdEfGhIjKlMnOpQrStUv")).toBe("https://open.spotify.com/album/AbCdEfGhIjKlMnOpQrStUv");
  });

  it("gives no link for missing or malformed IDs (local files, unavailable items, anything injected)", () => {
    for (const id of [null, undefined, "", "short", "0000000000000000000001/../x", "javascript:alert(1)00000000"]) {
      expect(spotifyUrl("track", id)).toBeNull();
    }
  });
});
