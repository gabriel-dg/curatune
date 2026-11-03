import { describe, expect, it } from "vitest";
import { CuratuneError } from "../src/spotify/errors";
import { SpotifyClient } from "../src/spotify/http";
import { getPlaylist, listPlaylists } from "../src/spotify/playlists";
import { fakeFetch, json, noSleep, rejection } from "./helpers";

const PLAYLIST_ID = "0123456789abcdefABCDEF";

function track(n: number) {
  return {
    uri: `spotify:track:${String(n).padStart(22, "0")}`,
    id: String(n).padStart(22, "0"),
    type: "track",
    name: `Track ${n}`,
    artists: [{ name: "Artist", uri: "spotify:artist:a" }],
    album: { name: "Album", uri: "spotify:album:b", artists: [] },
    duration_ms: 180_000,
  };
}

/**
 * A tiny fake of the endpoints the reads use. Every read of the playlist's snapshot_id (metadata or check)
 * takes the next value of `snapshots`; the last one repeats.
 */
function fakeApi(options: { items: unknown[]; snapshots?: string[]; itemsStatus?: number }) {
  const snapshots = [...(options.snapshots ?? ["snap1"])];
  const nextSnapshot = () => (snapshots.length > 1 ? snapshots.shift()! : snapshots[0]!);
  const { fetch, requests } = fakeFetch((url) => {
    const path = url.pathname;
    if (path === "/v1/me") return json({ id: "me", display_name: "Me" });
    if (path === "/v1/me/playlists") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const all = [
        { id: "a".repeat(22), name: "Mine", owner: { id: "me" }, items: { total: 3 }, public: true },
        null,
        { id: "b".repeat(22), name: "Theirs", owner: { id: "other", display_name: "Other" }, items: { total: 9 } },
      ];
      const page = all.slice(offset, offset + 2);
      const next = offset + 2 < all.length ? `https://api.spotify.com/v1/me/playlists?offset=${offset + 2}&limit=2` : null;
      return json({ items: page, next });
    }
    if (path === `/v1/playlists/${PLAYLIST_ID}`) {
      const fields = url.searchParams.get("fields");
      if (fields === "snapshot_id") return json({ snapshot_id: nextSnapshot() });
      return json({
        id: PLAYLIST_ID,
        name: "Test",
        description: "",
        owner: { id: "me" },
        public: true,
        collaborative: false,
        snapshot_id: nextSnapshot(),
      });
    }
    if (path === `/v1/playlists/${PLAYLIST_ID}/items`) {
      if (options.itemsStatus) return json({ error: { status: options.itemsStatus, message: "Forbidden" } }, options.itemsStatus);
      expect(url.searchParams.get("market")).toBeNull();
      const limit = Number(url.searchParams.get("limit"));
      expect(limit).toBeLessThanOrEqual(50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const next =
        offset + limit < options.items.length
          ? `https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/items?offset=${offset + limit}&limit=${limit}`
          : null;
      return json({ items: options.items.slice(offset, offset + limit), next, total: options.items.length });
    }
    return json({ error: { status: 404, message: "Not found" } }, 404);
  });
  const client = new SpotifyClient({ accessToken: async () => "t" }, { fetch, sleep: noSleep });
  return { client, requests };
}

describe("listPlaylists", () => {
  it("lists every page, skips null entries, and marks ownership", async () => {
    const { client } = fakeApi({ items: [] });
    const data = await listPlaylists(client);
    expect(data.user_id).toBe("me");
    expect(data.count).toBe(2);
    expect(data.playlists.map((p) => [p.name, p.owned, p.item_count])).toEqual([
      ["Mine", true, 3],
      ["Theirs", false, 9],
    ]);
  });

  it("filters owned playlists", async () => {
    const { client } = fakeApi({ items: [] });
    expect((await listPlaylists(client, true)).playlists.map((p) => p.name)).toEqual(["Mine"]);
  });
});

describe("getPlaylist", () => {
  it("reads all items across pages of 50", async () => {
    const items = Array.from({ length: 120 }, (_, i) => ({ added_at: "2026-09-28T00:00:00Z", item: track(i) }));
    const { client, requests } = fakeApi({ items });
    const state = await getPlaylist(client, `https://open.spotify.com/playlist/${PLAYLIST_ID}`);
    expect(state.items).toHaveLength(120);
    expect(state.items[119]!.position).toBe(119);
    expect(state.items[119]!.name).toBe("Track 119");
    expect(state.playlist.item_count).toBe(120);
    expect(state.playlist.owned).toBe(true);
    expect(state.warnings).toEqual([]);
    expect(requests.filter((r) => r.url.includes("/items")).length).toBe(3);
  });

  it("warns about local files and unavailable items", async () => {
    const items = [
      { item: track(0) },
      { is_local: true, item: { ...track(1), uri: "spotify:local:a:b:c:180" } },
      { item: null },
    ];
    const { client } = fakeApi({ items });
    const { warnings } = await getPlaylist(client, PLAYLIST_ID);
    expect(warnings.map((w) => [w.code, w.positions])).toEqual([
      ["LOCAL_FILES", [1]],
      ["UNAVAILABLE_ITEMS", [2]],
    ]);
  });

  it("re-reads when the snapshot changes during the read", async () => {
    // First attempt: metadata says snap1, the check says snap2. The second attempt is consistent.
    const { client, requests } = fakeApi({ items: [{ item: track(0) }], snapshots: ["snap1", "snap2"] });
    const state = await getPlaylist(client, PLAYLIST_ID);
    expect(state.playlist.snapshot_id).toBe("snap2");
    expect(requests.filter((r) => r.url.includes("/items")).length).toBe(2);
  });

  it("fails with CONCURRENT_MODIFICATION when it never settles", async () => {
    const { client } = fakeApi({ items: [], snapshots: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"] });
    const err = await rejection(getPlaylist(client, PLAYLIST_ID), CuratuneError);
    expect(err.code).toBe("CONCURRENT_MODIFICATION");
  });

  it("explains 403 on items", async () => {
    const { client } = fakeApi({ items: [], itemsStatus: 403 });
    const err = await rejection(getPlaylist(client, PLAYLIST_ID), CuratuneError);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toMatch(/own or collaborate/);
    expect(err.details.playlist_id).toBe(PLAYLIST_ID);
  });

  it("rejects bad references before any request", async () => {
    const { client, requests } = fakeApi({ items: [] });
    const err = await rejection(getPlaylist(client, "https://evil.example/playlist/x"), CuratuneError);
    expect(err.code).toBe("INVALID_REFERENCE");
    expect(requests).toHaveLength(0);
  });
});
