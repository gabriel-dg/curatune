import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatModel, Completion } from "../src/agent/llm";
import { runTurn } from "../src/agent/loop";
import { CuratuneError } from "../src/spotify/errors";
import { SpotifyClient } from "../src/spotify/http";
import { addItems, createPlaylist } from "../src/spotify/writes";
import { ALL_TOOLS, executeTool, WRITE_TOOLS } from "../src/tools";
import { buildFixture, fakeId, FakeSpotify } from "./fake-spotify";
import { noSleep, rejection } from "./helpers";

function setup() {
  const fixture = buildFixture();
  const spotify = new FakeSpotify(fixture);
  const client = new SpotifyClient({ accessToken: async () => "token" }, { fetch: spotify.fetch, sleep: noSleep });
  return { fixture, spotify, client, ids: fixture.ids };
}

const uri = (id: string) => `spotify:track:${id}`;
const fail = (promise: Promise<unknown>) => rejection(promise, CuratuneError);

describe("createPlaylist", () => {
  it("requests a private playlist and reports the visibility Spotify actually applied", async () => {
    const { client, spotify } = setup();
    const result = await createPlaylist(client, "  New list ", "Some notes");
    expect(spotify.writes).toEqual([{ method: "POST", path: "/v1/me/playlists", body: { name: "New list", public: false, description: "Some notes" } }]);
    expect(result.playlist).toMatchObject({ name: "New list", public: true, owned: true, item_count: 0 });
    expect(result.visibility).toEqual({ requested_public: false, reported_public: true });
    expect(result.warnings.map((w) => w.code)).toEqual(["VISIBILITY_NOT_APPLIED"]);
    expect(spotify.playlistByName("New list")?.public).toBe(true);
  });

  it("rejects a name the user already owns (trimmed, case-insensitive) before creating", async () => {
    const { client, spotify } = setup();
    const err = await fail(createPlaylist(client, " bebop TEST "));
    expect(err.code).toBe("DUPLICATE_NAME");
    expect(err.details.existing).toEqual([{ id: buildFixture().ids.bebop, name: "Bebop test" }]);
    expect(spotify.writes).toEqual([]);
  });

  it("allows a duplicate name when asked, and ignores playlists owned by others", async () => {
    const { client } = setup();
    expect((await createPlaylist(client, "Bebop test", "", true)).playlist.name).toBe("Bebop test");
    expect((await createPlaylist(client, "Lofi Beats to Relax")).playlist.name).toBe("Lofi Beats to Relax");
  });

  it("rejects an empty name", async () => {
    const { client } = setup();
    expect((await fail(createPlaylist(client, "   "))).code).toBe("INVALID_ARGUMENT");
  });
});

describe("addItems", () => {
  it("appends, verifies with a re-read, and skips tracks already present or repeated", async () => {
    const { client, spotify, ids } = setup();
    const result = await addItems(client, ids.bebop!, [uri(ids.saltLive!), uri(ids.koko!), uri(ids.zanzibar!), uri(ids.zanzibar!)]);
    expect(result.added).toEqual([
      { position: 12, uri: uri(ids.saltLive!) },
      { position: 13, uri: uri(ids.zanzibar!) },
    ]);
    expect(result.skipped).toEqual([
      { uri: uri(ids.koko!), reason: "already_in_playlist" },
      { uri: uri(ids.zanzibar!), reason: "duplicate_in_input" },
    ]);
    expect(result.item_count).toBe(14);
    expect(result.verified).toBe(true);
    expect(spotify.writes).toHaveLength(1);
    expect(spotify.writes[0]!.body).toEqual({ uris: [uri(ids.saltLive!), uri(ids.zanzibar!)] });
  });

  it("inserts at a position", async () => {
    const { client, spotify, ids } = setup();
    const result = await addItems(client, ids.bebop!, [uri(ids.zanzibar!)], 0);
    expect(result.added).toEqual([{ position: 0, uri: uri(ids.zanzibar!) }]);
    expect(spotify.playlistByName("Bebop test")!.items[0]).toBe(ids.zanzibar);
  });

  it("adds duplicates only when allowed", async () => {
    const { client, ids } = setup();
    const result = await addItems(client, ids.bebop!, [uri(ids.koko!)], null, true);
    expect(result.added).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it("writes nothing when every track is already present", async () => {
    const { client, spotify, ids } = setup();
    const result = await addItems(client, ids.bebop!, [uri(ids.koko!)]);
    expect(result.added).toEqual([]);
    expect(result.items_after).toBeNull();
    expect(spotify.writes).toEqual([]);
  });

  it("splits more than 100 tracks into chunks, keeping order and positions", async () => {
    const { client, spotify, fixture, ids } = setup();
    const pop = fixture.playlists.find((p) => p.id === ids.big)!.items.slice(0, 120) as string[];
    const target = (await createPlaylist(client, "Chunks")).playlist.id!;
    spotify.writes.length = 0;
    const result = await addItems(client, target, pop.map(uri), 0);
    expect(spotify.writes.map((w) => [(w.body as { uris: string[] }).uris.length, (w.body as { position: number }).position])).toEqual([
      [100, 0],
      [20, 100],
    ]);
    expect(result.verified).toBe(true);
    expect(spotify.playlistByName("Chunks")!.items).toEqual(pop);
  });

  it("refuses playlists the user does not own, before writing", async () => {
    const { client, spotify, ids } = setup();
    // Reading the items of someone else's playlist already fails with FORBIDDEN.
    expect((await fail(addItems(client, ids.lofi!, [uri(ids.zanzibar!)]))).code).toBe("FORBIDDEN");
    expect(spotify.writes).toEqual([]);
  });

  it("validates positions and references", async () => {
    const { client, ids } = setup();
    expect((await fail(addItems(client, ids.bebop!, [uri(ids.zanzibar!)], 13))).code).toBe("INVALID_ARGUMENT");
    expect((await fail(addItems(client, ids.bebop!, []))).code).toBe("INVALID_ARGUMENT");
    expect((await fail(addItems(client, ids.bebop!, ["spotify:local:a:b:c:1"]))).code).toBe("INVALID_REFERENCE");
  });

  it("reports an unverified write instead of a failure when the re-read fails", async () => {
    const fixture = buildFixture();
    const spotify = new FakeSpotify(fixture);
    let wrote = false;
    const client = new SpotifyClient(
      { accessToken: async () => "token" },
      {
        fetch: async (input, init) => {
          if (wrote && (init?.method ?? "GET") === "GET") return new Response(null, { status: 404 });
          const resp = await spotify.fetch(input, init);
          if (init?.method === "POST") wrote = true;
          return resp;
        },
        sleep: noSleep,
      },
    );
    const result = await addItems(client, fixture.ids.bebop!, [uri(fixture.ids.zanzibar!)]);
    expect(result.added).toHaveLength(1);
    expect(result.verified).toBe(false);
  });
});

describe("write tools", () => {
  it("exist next to the read tools; removals, reorders, and renames only as plans; nothing applies or sets visibility", () => {
    expect(WRITE_TOOLS.map((t) => t.name)).toEqual(["playlist_create", "playlist_add"]);
    const names = ALL_TOOLS.map((t) => t.name);
    expect(names.join(" ")).not.toMatch(/apply|delete|update|visib|private|public/);
    for (const name of names.filter((n) => !n.startsWith("plan_"))) expect(name).not.toMatch(/remove|rename|reorder|move|detail/);
    for (const tool of ALL_TOOLS) expect(Object.keys(tool.parameters.properties).join(" ")).not.toMatch(/public|private|visib|collaborative/);
  });

  it("playlist_add converts at_number to a position and reports numbers and names", async () => {
    const { client, ids } = setup();
    const execution = await executeTool(
      ALL_TOOLS,
      "playlist_add",
      JSON.stringify({ playlist_id: ids.bebop, track_uris: [uri(ids.zanzibar!)], at_number: 3 }),
      { client, isKnownId: () => true },
    );
    expect(execution.outcome).toEqual({
      ok: true,
      result: {
        playlist: { id: ids.bebop, name: "Bebop test" },
        added: [{ number: 3, uri: uri(ids.zanzibar!), name: "Zanzibar Sunset", artists: ["The Last Band"] }],
        skipped: [],
        item_count: 13,
        verified: true,
      },
    });
    expect(execution.write).toEqual({
      title: 'Added 1 track to "Bebop test" (now 13)',
      lines: ["3. Zanzibar Sunset - The Last Band"],
      playlistId: ids.bebop,
      warnings: [],
      // What the playlist holds after the add: the sidebar shows it while Spotify's list lags.
      itemCount: 13,
    });
  });

  it("playlist_add refuses IDs that did not appear in the conversation", async () => {
    const { client, spotify, ids } = setup();
    const invented = fakeId("invented");
    const execution = await executeTool(
      ALL_TOOLS,
      "playlist_add",
      JSON.stringify({ playlist_id: ids.bebop, track_uris: [uri(ids.zanzibar!), uri(invented)] }),
      { client, isKnownId: (id) => id !== invented },
    );
    expect(execution.outcome).toMatchObject({ ok: false, error: { code: "INVALID_REFERENCE", message: expect.stringContaining(invented) } });
    expect(execution.write).toBeNull();
    expect(spotify.writes).toEqual([]);
  });

  it("playlist_add with nothing new reports no write", async () => {
    const { client, ids } = setup();
    const execution = await executeTool(ALL_TOOLS, "playlist_add", JSON.stringify({ playlist_id: ids.bebop, track_uris: [uri(ids.koko!)] }), { client });
    expect(execution.outcome.ok).toBe(true);
    expect(execution.write).toBeNull();
  });

  it("playlist_create reports the new playlist, public", async () => {
    const { client } = setup();
    const execution = await executeTool(ALL_TOOLS, "playlist_create", JSON.stringify({ name: "Bebop essentials" }), { client });
    expect(execution.outcome).toMatchObject({ ok: true, result: { playlist: { name: "Bebop essentials", public: true, items: 0 } } });
    expect(execution.write).toMatchObject({ title: 'Created playlist "Bebop essentials"', lines: ["Public (Spotify ignores private on creation)."], itemCount: 0 });
  });
});

describe("the loop only lets write tools use IDs from the conversation", () => {
  function completion(calls: [string, unknown][], content = ""): Completion {
    return {
      content,
      toolCalls: calls.map(([name, args], i) => ({ id: `c${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })),
      finishReason: null,
      usage: null,
    };
  }

  class Scripted implements ChatModel {
    constructor(private readonly steps: ((messages: ChatMessage[]) => Completion)[]) {}
    async complete(messages: ChatMessage[]) {
      return this.steps.shift()!(messages);
    }
  }

  it("rejects an invented URI and accepts one taken from a search result", async () => {
    const { client, spotify, ids } = setup();
    const invented = fakeId("hallucinated");
    const model = new Scripted([
      () => completion([["playlist_add", { playlist_id: ids.bebop, track_uris: [uri(invented)] }]]),
      () => completion([["search_tracks", { track: "Zanzibar Sunset" }]]),
      (messages) => {
        const found = JSON.parse((messages.at(-1) as { content: string }).content).result.results[0].uri;
        return completion([["playlist_add", { playlist_id: ids.bebop, track_uris: [found] }]]);
      },
      () => completion([], "Added."),
    ]);
    const result = await runTurn([], `Add Zanzibar Sunset to my playlist ${ids.bebop}`, { model, tools: ALL_TOOLS, ctx: { client } });
    expect(result.executions.map((e) => [e.name, e.outcome.ok])).toEqual([
      ["playlist_add", false],
      ["search_tracks", true],
      ["playlist_add", true],
    ]);
    expect(spotify.playlistByName("Bebop test")!.items.at(-1)).toBe(ids.zanzibar);
  });
});
