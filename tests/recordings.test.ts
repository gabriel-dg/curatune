// Port of spotikit's tests/test_recordings.py (spotikit commit b3531aa), plus the web-only import/export and
// the recording tools, against the in-memory fake Spotify.

import { describe, expect, it } from "vitest";
import { applyPlan, buildReorderPlan } from "../src/plans/plans";
import { chronologicalOrder, playlistRecordings, RecordingStore, validateEntry, validateRecorded } from "../src/recordings/recordings";
import { SpotikitError } from "../src/spotify/errors";
import { SpotifyClient } from "../src/spotify/http";
import type { PlaylistItem } from "../src/spotify/models";
import { MemoryStore } from "../src/storage/kv";
import { ALL_TOOLS, executeTool } from "../src/tools";
import { buildFixture, fakeId, FakeSpotify } from "./fake-spotify";
import { noSleep, rejection } from "./helpers";

const trackUri = (n: number) => `spotify:track:${fakeId(`rec:${n}`)}`;
const entry = (n: number, recorded: string, extra: Record<string, unknown> = {}) => ({ uri: trackUri(n), recorded, confidence: "high", source: "test", ...extra });
const item = (position: number, uri: string, isrc: string | null = null) => ({ position, uri, name: `T${position}`, isrc }) as PlaylistItem;
const fail = (promise: Promise<unknown>) => rejection(promise, SpotikitError);

describe("validation", () => {
  it.each(["1947", "1947-12", "1947-12-05"])("accepts %s", (value) => {
    expect(validateRecorded(value)).toBe(value);
  });

  it.each(["47", "1947-13", "1947-02-30", "1947/12/05", null, 1947])("rejects %j", (value) => {
    expect(() => validateRecorded(value)).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("requires a valid confidence and a source", () => {
    expect(() => validateEntry({ uri: trackUri(1), recorded: "1947", confidence: "sure", source: "x" })).toThrow(SpotikitError);
    expect(() => validateEntry({ uri: trackUri(1), recorded: "1947", confidence: "high", source: " " })).toThrow(SpotikitError);
    expect(() => validateEntry({ recorded: "1947" })).toThrow(SpotikitError);
  });
});

describe("store", () => {
  it("upserts all-or-nothing", async () => {
    const store = new RecordingStore(new MemoryStore());
    await store.upsert([entry(1, "1945")]);
    await expect(store.upsert([entry(2, "1946"), entry(3, "not-a-date")])).rejects.toThrow(SpotikitError);
    expect(Object.keys(await store.load())).toEqual([trackUri(1)]);
  });

  it("creates and updates", async () => {
    const store = new RecordingStore(new MemoryStore());
    expect((await store.upsert([entry(1, "1945")])).created).toBe(1);
    const result = await store.upsert([entry(1, "1945-11-26", { note: "master" }), entry(2, "1946")]);
    expect([result.created, result.updated, result.total]).toEqual([1, 1, 2]);
    expect((await store.load())[trackUri(1)]!.note).toBe("master");
  });

  it("imports spotikit's recordings.json and exports the same format", async () => {
    const store = new RecordingStore(new MemoryStore());
    const spotikitFile = JSON.stringify({
      [trackUri(2)]: { recorded: "1947-12-05", confidence: "high", source: "AllMusic session notes", name: "Nostalgia", artists: ["Fats Navarro"] },
      [trackUri(1)]: { recorded: "1945", confidence: "medium", source: "liner notes" },
    });
    expect(await store.importJson(spotikitFile)).toEqual({ created: 2, updated: 0, total: 2 });
    const exported = JSON.parse(await store.exportJson());
    expect(Object.keys(exported)).toEqual([trackUri(1), trackUri(2)].sort());
    expect(Object.keys(exported[trackUri(2)])).toEqual(["artists", "confidence", "name", "recorded", "source"]);
    // Round trip into a fresh store.
    const other = new RecordingStore(new MemoryStore());
    await other.importJson(await store.exportJson());
    expect(await other.load()).toEqual(await store.load());
  });

  it("rejects an invalid import without writing anything", async () => {
    const store = new RecordingStore(new MemoryStore());
    expect((await fail(store.importJson("not json"))).code).toBe("INVALID_ARGUMENT");
    expect((await fail(store.importJson("[]"))).code).toBe("INVALID_ARGUMENT");
    await expect(store.importJson(JSON.stringify({ [trackUri(1)]: { recorded: "1945", confidence: "high" } }))).rejects.toThrow(/source/);
    expect(await store.load()).toEqual({});
  });

  it("removes entries", async () => {
    const store = new RecordingStore(new MemoryStore());
    await store.upsert([entry(1, "1945"), entry(2, "1946")]);
    expect(await store.remove([trackUri(1), trackUri(9)])).toBe(1);
    expect(Object.keys(await store.load())).toEqual([trackUri(2)]);
  });
});

describe("chronological order", () => {
  it("is stable for ties", async () => {
    const store = new RecordingStore(new MemoryStore());
    await store.upsert([entry(0, "1947"), entry(1, "1945-11-26"), entry(2, "1945-11-26"), entry(3, "1939")]);
    const items = [0, 1, 2, 3].map((i) => item(i, trackUri(i)));
    expect(chronologicalOrder(items, await store.load())).toEqual([3, 1, 2, 0]);
  });

  it("matches by ISRC (the same recording on another edition)", async () => {
    const store = new RecordingStore(new MemoryStore());
    await store.upsert([entry(9, "1945", { isrc: "USX1" }), entry(1, "1946")]);
    const items = [item(0, trackUri(1)), item(1, trackUri(5), "USX1")];
    expect(chronologicalOrder(items, await store.load())).toEqual([1, 0]);
  });

  it("reports missing dates", async () => {
    const store = new RecordingStore(new MemoryStore());
    await store.upsert([entry(0, "1947")]);
    const items = [0, 1, 2].map((i) => item(i, trackUri(i)));
    try {
      chronologicalOrder(items, await store.load());
      throw new Error("expected RECORDING_DATES_MISSING");
    } catch (exc) {
      expect((exc as SpotikitError).code).toBe("RECORDING_DATES_MISSING");
      expect(((exc as SpotikitError).details.missing as { position: number }[]).map((m) => m.position)).toEqual([1, 2]);
    }
  });
});

// The Bebop test fixture, with recording years (same as the project's real test playlist).
const BEBOP_YEARS: [string, string][] = [
  ["unPocoLoco", "1951-05-01"], ["koko", "1945-11-26"], ["woodyNYou", "1944-02-16"], ["manteca", "1947-12-30"],
  ["swingToBop", "1941-05"], ["roundMonk", "1947-11-21"], ["boplicity", "1949-04-22"], ["saltPeanuts", "1945-05-11"],
  ["ladyBird", "1948-09-13"],
];

function setup() {
  const fixture = buildFixture();
  const spotify = new FakeSpotify(fixture);
  const client = new SpotifyClient({ accessToken: async () => "token" }, { fetch: spotify.fetch, sleep: noSleep });
  const store = new RecordingStore(new MemoryStore());
  const ids = fixture.ids;
  const bebop = fixture.playlists.find((p) => p.id === ids.bebop)!;
  return { fixture, spotify, client, store, ids, bebop };
}

describe("with a playlist", () => {
  it("joins a playlist with the store, reporting missing dates and chronology", async () => {
    const { client, store, ids } = setup();
    await store.upsert(BEBOP_YEARS.slice(0, 3).map(([key, recorded]) => ({ uri: `spotify:track:${ids[key]}`, recorded, confidence: "high", source: "test" })));
    const result = await playlistRecordings(client, store, ids.bebop!);
    expect(result.items[0]!.matched_by).toBe("uri");
    // Ko-Ko on the other edition (track 11) matches nothing: the fixture stores no ISRC for it.
    expect(result.missing.length).toBe(12 - 4); // tracks 1, 2, 7 (same URI as 2), and 12 are dated
    expect(result.chronological).toBe(false);
  });

  it("builds a reorder plan by recording date, which applies", async () => {
    const { client, store, ids, bebop } = setup();
    // Koko2 (track 11) is the same recording as Ko-Ko: store it by ISRC through the Ko-Ko entry.
    await store.upsert([
      ...BEBOP_YEARS.map(([key, recorded]) => ({ uri: `spotify:track:${ids[key]}`, recorded, confidence: "high", source: "test", ...(key === "koko" ? { isrc: "USSVY4500001" } : {}) })),
      { uri: `spotify:track:${fakeId("track:roundmiles")}`, recorded: "1956-09-10", confidence: "high", source: "test" },
    ]);
    const plan = await buildReorderPlan(client, ids.bebop!, { recordings: await store.load() });
    // Chronological order of the test playlist: 4, 11, 8, 1, 6, 10, 5, 3, 9, 7, 0, 2 (0-based).
    expect(plan.changes.new_order).toEqual([4, 11, 8, 1, 6, 10, 5, 3, 9, 7, 0, 2]);
    await applyPlan(client, plan, new MemoryStore());
    expect(bebop.items[0]).toBe(ids.swingToBop);
    expect(bebop.items.at(-1)).toBe(fakeId("track:roundmiles"));
  });

  it("rejects a reorder when the playlist is already chronological", async () => {
    const { client, store, fixture, ids } = setup();
    const plain = fixture.playlists.find((p) => p.id === ids.mixed)!; // Salt Peanuts, unavailable, Salt Peanuts live
    plain.items = [ids.woodyNYou!, ids.saltPeanuts!];
    await store.upsert([
      { uri: `spotify:track:${ids.woodyNYou}`, recorded: "1944", confidence: "high", source: "t" },
      { uri: `spotify:track:${ids.saltPeanuts}`, recorded: "1945", confidence: "high", source: "t" },
    ]);
    expect((await fail(buildReorderPlan(client, ids.mixed!, { recordings: await store.load() }))).code).toBe("NO_CHANGES");
  });
});

describe("recording tools", () => {
  const run = (ctx: ReturnType<typeof setup>, name: string, args: unknown, known = true) =>
    executeTool(ALL_TOOLS, name, JSON.stringify(args), { client: ctx.client, recordings: ctx.store, isKnownId: () => known });

  it("recordings_set stores dates, reports them as a local write, and refuses unknown URIs", async () => {
    const ctx = setup();
    const uri = `spotify:track:${ctx.ids.manteca}`;
    const execution = await run(ctx, "recordings_set", { entries: [{ uri, recorded: "1947-12-30", confidence: "medium", source: "model knowledge", name: "Manteca" }] });
    expect(execution.outcome).toMatchObject({ ok: true, result: { created: 1, updated: 0, total: 1 } });
    expect(execution.write).toMatchObject({ title: "Saved 1 recording date (in this browser)", lines: ["Manteca: 1947-12-30 (medium)"], playlistId: null });
    expect((await ctx.store.load())[uri]).toMatchObject({ recorded: "1947-12-30", confidence: "medium", source: "model knowledge" });
    const unknown = await run(ctx, "recordings_set", { entries: [{ uri, recorded: "1947", confidence: "high", source: "x" }] }, false);
    expect(unknown.outcome).toMatchObject({ ok: false, error: { code: "INVALID_REFERENCE" } });
    const bad = await run(ctx, "recordings_set", { entries: [{ uri, recorded: "late 40s", confidence: "high", source: "x" }] });
    expect(bad.outcome).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });

  it("recordings_show numbers tracks from 1 and lists the missing ones", async () => {
    const ctx = setup();
    await ctx.store.upsert([{ uri: `spotify:track:${ctx.ids.unPocoLoco}`, recorded: "1951-05-01", confidence: "high", source: "t" }]);
    const execution = await run(ctx, "recordings_show", { playlist_id: ctx.ids.bebop });
    const result = (execution.outcome as { result: any }).result;
    expect(result.items[0]).toMatchObject({ number: 1, recorded: "1951-05-01", confidence: "high" });
    expect(result.missing[0]).toMatchObject({ number: 2, name: "Ko-Ko" });
    expect(execution.summary).toBe("1/12 dated");
  });

  it("plan_reorder with sort_by recorded names the tracks without dates", async () => {
    const ctx = setup();
    const execution = await run(ctx, "plan_reorder", { playlist_id: ctx.ids.bebop, sort_by: "recorded" });
    expect(execution.outcome).toMatchObject({ ok: false, error: { code: "RECORDING_DATES_MISSING", message: expect.stringContaining("1. Un Poco Loco") } });
  });
});
