import { describe, expect, it } from "vitest";
import { buildQuery } from "../src/spotify/catalog";
import { CuratuneError } from "../src/spotify/errors";
import { SpotifyClient } from "../src/spotify/http";
import { executeTool, MAX_RESULT_CHARS, READ_TOOLS, RECORDING_TOOLS, toolDefinitions, type Tool } from "../src/tools";
import { THIRD_PARTY_NOTE } from "../src/tools/types";
import { validateArgs, type ObjectSchema } from "../src/tools/schema";
import { buildFixture, FakeSpotify, INJECTION_DESCRIPTION } from "./fake-spotify";
import { noSleep, rejection } from "./helpers";

function setup() {
  const fixture = buildFixture();
  const spotify = new FakeSpotify(fixture);
  const client = new SpotifyClient({ accessToken: async () => "token" }, { fetch: spotify.fetch, sleep: noSleep });
  const run = async (name: string, args: unknown) => {
    const execution = await executeTool(READ_TOOLS, name, JSON.stringify(args), { client });
    return { execution, outcome: execution.outcome, result: execution.outcome.ok ? (execution.outcome.result as any) : null };
  };
  return { fixture, spotify, client, run, ids: fixture.ids };
}

describe("validateArgs", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: {
      name: { type: "string", description: "", minLength: 1 },
      count: { type: "integer", description: "", minimum: 1, maximum: 10 },
      flag: { type: "boolean", description: "" },
    },
    required: ["name"],
    additionalProperties: false,
  };

  it("accepts valid arguments and coerces numeric and boolean strings", () => {
    expect(validateArgs(schema, { name: "x", count: "3", flag: "true" })).toEqual({ name: "x", count: 3, flag: true });
    expect(validateArgs(schema, { name: "x", count: null })).toEqual({ name: "x" });
  });

  it.each([
    [null, "object"],
    [[], "object"],
    [{}, "Missing"],
    [{ name: "" }, "empty"],
    [{ name: 1 }, "string"],
    [{ name: "x", count: 1.5 }, "integer"],
    [{ name: "x", count: 11 }, "between"],
    [{ name: "x", flag: "yes" }, "boolean"],
    [{ name: "x", extra: 1 }, "Unknown"],
  ])("rejects %j", (value, fragment) => {
    expect(() => validateArgs(schema, value)).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT", message: expect.stringContaining(fragment) }));
  });
});

describe("tool definitions", () => {
  it("exposes only the read tools, with strict schemas", () => {
    const defs = toolDefinitions(READ_TOOLS);
    expect(defs.map((d) => d.function.name)).toEqual(["playlists_list", "playlist_show", "search_tracks", "search_many", "track_show", "album_tracks"]);
    for (const d of defs) {
      expect(d.type).toBe("function");
      expect(d.function.parameters.additionalProperties).toBe(false);
    }
  });

  it("has no tool that writes or applies anything", () => {
    const names = READ_TOOLS.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/apply|add|remove|delete|create|rename|reorder|update|visibility/);
  });
});

describe("read tools", () => {
  it("playlists_list returns compact playlists", async () => {
    const { run, ids } = setup();
    const { result } = await run("playlists_list", {});
    expect(result.count).toBe(5);
    expect(result.playlists[0]).toEqual({ id: ids.bebop, name: "Bebop test", owner: "you", owned: true, collaborative: false, items: 12 });
    expect(result.playlists[3].owner).toBe("Lofi Channel");
    const owned = await run("playlists_list", { owned_only: true });
    expect(owned.result.count).toBe(4);
  });

  it("never sends cover image URLs to the model", async () => {
    const { run, ids } = setup();
    for (const [name, args] of [["playlists_list", {}], ["playlist_show", { playlist_id: ids.bebop }]] as const) {
      const { execution } = await run(name, args);
      expect(execution.content).not.toMatch(/scdn\.co|spotifycdn/);
    }
  });

  it("playlist_show returns brief items, the total duration, and nothing about the session", async () => {
    const { run, ids } = setup();
    const { result, execution } = await run("playlist_show", { playlist_id: ids.bebop });
    expect(result.playlist).toMatchObject({ id: ids.bebop, name: "Bebop test", items: 12, total_duration: "46:52" });
    expect(result.next_offset).toBeNull();
    expect(result.items).toHaveLength(12);
    expect(result.items[1]).toEqual({
      number: 2,
      uri: `spotify:track:${ids.koko}`,
      name: "Ko-Ko",
      artists: ["Charlie Parker"],
      album: "The Savoy 10-inch LP Collection",
      released: "2020-02-28",
      duration: "2:57",
      isrc: "USSVY4500001",
    });
    expect(execution.content).not.toMatch(/snapshot|open\.spotify\.com|added_at|token/);
    expect(execution.summary).toBe("12 items");
  });

  it("playlist_show accepts URIs and URLs", async () => {
    const { run, ids } = setup();
    expect((await run("playlist_show", { playlist_id: `spotify:playlist:${ids.bebop}` })).outcome.ok).toBe(true);
    expect((await run("playlist_show", { playlist_id: `https://open.spotify.com/playlist/${ids.bebop}` })).outcome.ok).toBe(true);
  });

  it("playlist_show pages at 100 items", async () => {
    const { run, ids } = setup();
    const first = await run("playlist_show", { playlist_id: ids.big });
    expect(first.result.items).toHaveLength(100);
    expect(first.result.next_offset).toBe(100);
    expect(first.execution.summary).toBe("100 of 150 items");
    const second = await run("playlist_show", { playlist_id: ids.big, offset: 100 });
    expect(second.result.items).toHaveLength(50);
    expect(second.result.next_offset).toBeNull();
    expect(second.result.items.at(-1)).toMatchObject({ number: 150, name: "Zanzibar Sunset" });
  });

  it("playlist_show passes descriptions through as data, unescaped", async () => {
    const { run, ids } = setup();
    const { result } = await run("playlist_show", { playlist_id: ids.study });
    expect(result.playlist.description).toBe(INJECTION_DESCRIPTION);
  });

  it("playlist_show reports warnings for unavailable items", async () => {
    const { run, ids } = setup();
    const { result } = await run("playlist_show", { playlist_id: ids.mixed });
    expect(result.warnings).toEqual([{ code: "UNAVAILABLE_ITEMS", message: "Some items have no track object.", numbers: [2] }]);
  });

  it("returns API errors as tool errors the model can read", async () => {
    const { run, ids } = setup();
    const forbidden = await run("playlist_show", { playlist_id: ids.lofi });
    expect(forbidden.outcome).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "Playlist items are only available for playlists you own or collaborate on." },
    });
    const invented = await run("playlist_show", { playlist_id: "My playlist" });
    expect(invented.outcome.ok).toBe(false);
    expect((invented.outcome as any).error.code).toBe("INVALID_REFERENCE");
  });

  it("search_tracks builds the query and returns album URIs", async () => {
    const { run, ids } = setup();
    const { result } = await run("search_tracks", { track: "Salt Peanuts", artist: "Dizzy Gillespie" });
    expect(result.query).toBe('track:"Salt Peanuts" artist:"Dizzy Gillespie"');
    expect(result.results.map((r: any) => r.uri)).toEqual([`spotify:track:${ids.saltPeanuts}`, `spotify:track:${ids.saltLive}`]);
    expect(result.results[0].album_uri).toMatch(/^spotify:album:/);
  });

  it("search_tracks warns about the year filter and validates limits", async () => {
    const { run } = setup();
    const { result } = await run("search_tracks", { query: "salt peanuts", year: "1995" });
    expect(result.warnings.map((w: any) => w.code)).toEqual(["YEAR_IS_RELEASE_YEAR"]);
    expect((await run("search_tracks", {})).outcome).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    expect((await run("search_tracks", { query: "x", limit: 11 })).outcome).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });

  it("search_many runs several searches in one call, in order, and isolates failures", async () => {
    const { run, spotify, ids } = setup();
    const before = spotify.requests.length;
    const { result, execution } = await run("search_many", {
      searches: [
        { track: "Salt Peanuts", artist: "Dizzy Gillespie" },
        { track: "Take Five", artist: "Dave Brubeck" },
        { track: "Hot House" },
        { album: "Birth Of The Cool", track: "Boplicity" },
      ],
      limit_each: 1,
    });
    expect(result.count).toBe(4);
    expect(result.searches.map((s: any) => s.results?.[0]?.uri ?? null)).toEqual([
      `spotify:track:${ids.saltPeanuts}`,
      null,
      `spotify:track:${ids.hotHouse}`,
      `spotify:track:${ids.boplicity}`,
    ]);
    expect(result.searches[1].total).toBe(0);
    expect(spotify.requests.length - before).toBe(4);
    expect(execution.summary).toBe("4 searches, 1 without results");
    const failed = await run("search_many", { searches: [{ track: "Manteca" }, {}] });
    expect(failed.result.failed).toBe(1);
    expect(failed.result.searches[1].error.code).toBe("INVALID_ARGUMENT");
    expect(failed.result.searches[0].results.length).toBeGreaterThan(0);
  });

  it("search_many validates its arguments", async () => {
    const { run } = setup();
    const tooMany = Array.from({ length: 26 }, () => ({ track: "x" }));
    expect((await run("search_many", { searches: tooMany })).outcome).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    expect((await run("search_many", { searches: [{ title: "x" }] })).outcome).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    expect((await run("search_many", { searches: ["Salt Peanuts"] })).outcome).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });

  it("track_show returns one brief track", async () => {
    const { run, ids } = setup();
    const { result } = await run("track_show", { track_id: `https://open.spotify.com/track/${ids.koko2}` });
    expect(result.track).toMatchObject({ name: "Ko-Ko", isrc: "USSVY4500001", album: "Ornithology: The Best Of Bird" });
  });

  it("album_tracks lists the album once and its tracks in order", async () => {
    const { run, ids } = setup();
    const { result } = await run("album_tracks", { album_id: `spotify:album:${ids.cool}` });
    expect(result.album).toMatchObject({ name: "Birth Of The Cool", artists: ["Miles Davis"], total_tracks: 12 });
    expect(result.tracks.map((t: any) => t.name).slice(0, 3)).toEqual(["Move", "Jeru", "Moon Dreams"]);
    expect(result.tracks[7]).toMatchObject({ name: "Boplicity", track_number: 8, disc_number: 1 });
    expect(result.tracks[0].album).toBeUndefined();
  });
});

describe("executeTool", () => {
  it("reports unknown tools and invalid JSON to the model", async () => {
    const { client } = setup();
    const unknown = await executeTool(READ_TOOLS, "playlist_apply", "{}", { client });
    expect(unknown.outcome).toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOL" } });
    const bad = await executeTool(READ_TOOLS, "playlist_show", "{playlist_id:", { client });
    expect(bad.outcome).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", message: "Arguments are not valid JSON." } });
    const empty = await executeTool(READ_TOOLS, "playlists_list", "", { client });
    expect(empty.outcome.ok).toBe(true);
  });

  it("rethrows authorization errors instead of handing them to the model", async () => {
    const spotify = new FakeSpotify(buildFixture());
    const client = new SpotifyClient(
      { accessToken: async () => { throw new CuratuneError("AUTH_EXPIRED", "Log in again."); } },
      { fetch: spotify.fetch, sleep: noSleep },
    );
    const err = await rejection(executeTool(READ_TOOLS, "playlists_list", "{}", { client }), CuratuneError);
    expect(err.code).toBe("AUTH_EXPIRED");
  });

  it("replaces oversized results with an error", async () => {
    const { client } = setup();
    const huge: Tool = {
      name: "huge",
      description: "",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: async () => "x".repeat(MAX_RESULT_CHARS),
    };
    const execution = await executeTool([huge], "huge", "{}", { client });
    expect(execution.outcome).toMatchObject({ ok: false, error: { code: "RESULT_TOO_LARGE" } });
  });
});

describe("buildQuery", () => {
  it("quotes multi-word filters and strips quotes", () => {
    expect(buildQuery({ query: " free ", track: 'Say "Hi"', artist: "Bird", year: "1945-1947" })).toBe(
      'free track:"Say Hi" artist:Bird year:1945-1947',
    );
  });
});

describe("third-party text", () => {
  it("every read tool whose result carries Spotify text says it is data, not instructions", () => {
    for (const tool of [...READ_TOOLS, RECORDING_TOOLS.find((t) => t.name === "recordings_show")!]) {
      expect(tool.description, tool.name).toContain(THIRD_PARTY_NOTE.trim());
    }
  });
});
