import { describe, expect, it } from "vitest";
import {
  formatDuration,
  normalizePlaylist,
  normalizePlaylistItem,
  normalizeTrack,
  unescapeHtml,
} from "../src/spotify/models";

const TRACK = {
  uri: "spotify:track:0000000000000000000001",
  id: "0000000000000000000001",
  type: "track",
  name: "Ko-Ko",
  artists: [{ name: "Charlie Parker", uri: "spotify:artist:a", id: "a" }],
  album: {
    name: "The Savoy Recordings",
    uri: "spotify:album:b",
    album_type: "compilation",
    release_date: "2002",
    release_date_precision: "year",
    artists: [{ name: "Charlie Parker", uri: "spotify:artist:a" }],
  },
  duration_ms: 174_900,
  disc_number: 1,
  track_number: 12,
  external_ids: { isrc: "USXX14500001" },
  explicit: false,
  is_local: false,
  external_urls: { spotify: "https://open.spotify.com/track/0000000000000000000001" },
};

describe("formatDuration", () => {
  it("formats m:ss", () => {
    expect(formatDuration(174_900)).toBe("2:54");
    expect(formatDuration(5_000)).toBe("0:05");
    expect(formatDuration(3_600_000)).toBe("60:00");
    expect(formatDuration(null)).toBeNull();
  });
});

describe("unescapeHtml", () => {
  it("decodes the entities Spotify emits", () => {
    expect(unescapeHtml("Bird&#x27;s &amp; Diz &quot;live&quot; &lt;1945&gt; &#39;x&#x2F;y")).toBe(
      "Bird's & Diz \"live\" <1945> 'x/y",
    );
  });

  it("leaves unknown or invalid entities alone", () => {
    expect(unescapeHtml("&unknown; &#0; &#x110000; & plain")).toBe("&unknown; &#0; &#x110000; & plain");
  });
});

describe("normalizeTrack", () => {
  it("normalizes a full track", () => {
    expect(normalizeTrack(TRACK)).toEqual({
      uri: TRACK.uri,
      id: TRACK.id,
      type: "track",
      name: "Ko-Ko",
      artists: [{ name: "Charlie Parker", uri: "spotify:artist:a" }],
      album: {
        name: "The Savoy Recordings",
        uri: "spotify:album:b",
        album_type: "compilation",
        release_date: "2002",
        release_date_precision: "year",
        artists: [{ name: "Charlie Parker", uri: "spotify:artist:a" }],
      },
      duration_ms: 174_900,
      duration: "2:54",
      disc_number: 1,
      track_number: 12,
      isrc: "USXX14500001",
      explicit: false,
      is_local: false,
      is_playable: null,
      url: TRACK.external_urls.spotify,
    });
  });

  it("uses the given album for simplified tracks", () => {
    const { album: _album, ...simplified } = TRACK;
    const album = normalizeTrack(TRACK).album;
    expect(normalizeTrack(simplified, album).album).toEqual(album);
  });

  it("maps episodes to their show", () => {
    const episode = normalizeTrack({
      type: "episode",
      uri: "spotify:episode:e",
      name: "Ep",
      show: { name: "Show", uri: "spotify:show:s" },
      release_date: "2024-01-02",
      release_date_precision: "day",
      duration_ms: 60_000,
    });
    expect(episode.album).toEqual({
      name: "Show",
      uri: "spotify:show:s",
      album_type: "show",
      release_date: "2024-01-02",
      release_date_precision: "day",
      artists: [],
    });
    expect(episode.artists).toEqual([]);
  });

  it("yields all-null keys for a missing object", () => {
    const empty = normalizeTrack(null);
    expect(empty.uri).toBeNull();
    expect(empty.artists).toEqual([]);
    expect(empty.is_local).toBe(false);
    expect(Object.keys(empty)).toEqual(Object.keys(normalizeTrack(TRACK)));
  });
});

describe("normalizePlaylistItem", () => {
  it("reads the post-2026 `item` field and the deprecated `track` alias", () => {
    const fromItem = normalizePlaylistItem({ added_at: "2026-09-28T10:00:00Z", item: TRACK }, 3);
    const fromTrack = normalizePlaylistItem({ added_at: "2026-09-28T10:00:00Z", track: TRACK }, 3);
    expect(fromItem).toEqual(fromTrack);
    expect(fromItem.position).toBe(3);
    expect(fromItem.added_at).toBe("2026-09-28T10:00:00Z");
    expect(fromItem.uri).toBe(TRACK.uri);
  });

  it("marks local files from the entry", () => {
    expect(normalizePlaylistItem({ is_local: true, item: { ...TRACK, uri: "spotify:local:x" } }, 0).is_local).toBe(true);
  });

  it("keeps unavailable items with a null URI", () => {
    const item = normalizePlaylistItem({ added_at: null, item: null }, 7);
    expect(item.position).toBe(7);
    expect(item.uri).toBeNull();
  });
});

describe("normalizePlaylist", () => {
  const raw = {
    id: "7xExamplePlaylistId001",
    uri: "spotify:playlist:7xExamplePlaylistId001",
    name: "Bebop",
    description: "Bird&#x27;s best",
    owner: { id: "me", display_name: "Me" },
    collaborative: false,
    public: true,
    items: { total: 12 },
    snapshot_id: "snap",
    external_urls: { spotify: "https://open.spotify.com/playlist/7xExamplePlaylistId001" },
    images: [
      { url: "https://mosaic.scdn.co/640/abc", width: 640, height: 640 },
      { url: "https://mosaic.scdn.co/60/abc", width: 60, height: 60 },
    ],
  };

  it("normalizes and unescapes the description", () => {
    expect(normalizePlaylist(raw, "me")).toEqual({
      id: raw.id,
      uri: raw.uri,
      name: "Bebop",
      description: "Bird's best",
      owner_id: "me",
      owner_name: "Me",
      owned: true,
      collaborative: false,
      public: true,
      item_count: 12,
      snapshot_id: "snap",
      url: raw.external_urls.spotify,
      images: raw.images,
    });
  });

  it("keeps usable images only, with null for unknown sizes", () => {
    const images = [{ url: "https://i.scdn.co/image/x", width: null, height: null }, { url: "" }, null, { width: 60 }];
    expect(normalizePlaylist({ ...raw, images }, "me").images).toEqual([{ url: "https://i.scdn.co/image/x", width: null, height: null }]);
    expect(normalizePlaylist({ ...raw, images: null }, "me").images).toEqual([]);
  });

  it("computes ownership", () => {
    expect(normalizePlaylist(raw, "someone-else").owned).toBe(false);
    expect(normalizePlaylist(raw, null).owned).toBe(false);
  });

  it("accepts the deprecated `tracks` total", () => {
    const { items: _items, ...old } = raw;
    expect(normalizePlaylist({ ...old, tracks: { total: 4 } }, "me").item_count).toBe(4);
  });
});
