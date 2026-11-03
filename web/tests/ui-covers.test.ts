import { describe, expect, it } from "vitest";
import { coverSources, initial, safeImageUrl } from "../src/ui/covers";

describe("safeImageUrl", () => {
  it("accepts https URLs on Spotify's image CDNs", () => {
    expect(safeImageUrl("https://i.scdn.co/image/ab67")).toBe("https://i.scdn.co/image/ab67");
    expect(safeImageUrl("https://mosaic.scdn.co/640/ab67")).toBe("https://mosaic.scdn.co/640/ab67");
    expect(safeImageUrl("https://image-cdn-ak.spotifycdn.com/image/ab67")).toBe("https://image-cdn-ak.spotifycdn.com/image/ab67");
  });

  it("rejects other hosts, schemes, credentials, and ports", () => {
    for (const url of [
      "http://i.scdn.co/image/x",
      "https://scdn.co.evil.test/x",
      "https://evilscdn.co/x",
      "https://i.scdn.co.evil.test/x",
      "https://user:pass@i.scdn.co/x",
      "https://i.scdn.co:8443/x",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "not a url",
    ]) {
      expect(safeImageUrl(url), url).toBeNull();
    }
  });
});

describe("coverSources", () => {
  it("offers every size to the browser, with a 300 px fallback", () => {
    const images = [640, 300, 60].map((w) => ({ url: `https://mosaic.scdn.co/${w}/x`, width: w, height: w }));
    expect(coverSources(images)).toEqual({
      src: "https://mosaic.scdn.co/300/x",
      srcset: "https://mosaic.scdn.co/60/x 60w, https://mosaic.scdn.co/300/x 300w, https://mosaic.scdn.co/640/x 640w",
    });
  });

  it("uses a single unsized image as is", () => {
    expect(coverSources([{ url: "https://i.scdn.co/image/x", width: null, height: null }])).toEqual({ src: "https://i.scdn.co/image/x", srcset: null });
  });

  it("skips unusable URLs, and gives null when none is left", () => {
    expect(coverSources([{ url: "https://evil.test/x.png", width: 640, height: 640 }, { url: "https://i.scdn.co/image/y", width: 300, height: 300 }])).toEqual({
      src: "https://i.scdn.co/image/y",
      srcset: null,
    });
    expect(coverSources([{ url: "https://evil.test/x.png", width: 640, height: 640 }])).toBeNull();
    expect(coverSources([])).toBeNull();
  });
});

describe("initial", () => {
  it("is the first letter, or ? when there is none", () => {
    expect(initial("  bebop")).toBe("B");
    expect(initial("")).toBe("?");
    expect(initial(null)).toBe("?");
  });
});
