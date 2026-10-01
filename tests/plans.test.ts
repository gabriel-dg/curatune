// Port of curatune's tests/test_plans.py, test_read_lag.py, and test_details.py (curatune commit b3531aa),
// against the in-memory fake Spotify. `spotify.writes` plays the role of curatune's `fake.mutations`.

import { describe, expect, it } from "vitest";
import { setDetails } from "../src/plans/ops";
import {
  applyPlan,
  buildDetailsPlan,
  buildRemovePlan,
  buildReorderPlan,
  checkPlan,
  computeMoves,
  computeRemoveOperations,
  orderFromMove,
  planChecksum,
  simulate,
  validatePlan,
  type ItemPlan,
  type Plan,
} from "../src/plans/plans";
import { CuratuneError } from "../src/spotify/errors";
import { SpotifyClient } from "../src/spotify/http";
import { getPlaylist, listPlaylists } from "../src/spotify/playlists";
import { WriteLog } from "../src/spotify/writelog";
import { addItems } from "../src/spotify/writes";
import { MemoryStore } from "../src/storage/kv";
import { buildFixture, fakeId, FakeSpotify, type FakePlaylist } from "./fake-spotify";
import { noSleep, rejection } from "./helpers";

const fail = (promise: Promise<unknown>) => rejection(promise, CuratuneError);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** Deterministic PRNG (mulberry32) for the permutation property test. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Pure helpers ---------------------------------------------------------------------------------------

describe("pure helpers", () => {
  it("computeMoves reaches any permutation", () => {
    for (let seed = 0; seed < 200; seed++) {
      const random = rng(seed);
      const n = 1 + Math.floor(random() * 60);
      const order = range(n);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      expect(simulate(range(n), computeMoves(order))).toEqual(order);
    }
  });

  it("uses at most one move per late addition (the bebop shape)", () => {
    // 31 items in order, then 10 late additions that belong at scattered earlier positions.
    const targets = [2, 5, 9, 12, 16, 20, 23, 26, 28, 30];
    const order = range(31);
    targets.forEach((target, offset) => order.splice(target + offset, 0, 31 + offset));
    const ops = computeMoves(order);
    expect(simulate(range(41), ops)).toEqual(order);
    expect(ops.length).toBeLessThanOrEqual(10);
  });

  it("turns a rotation into a single block move", () => {
    expect(computeMoves([1, 2, 3, 4, 0])).toEqual([{ op: "move", range_start: 1, insert_before: 0, range_length: 4 }]);
  });

  it("simulates moves down with Spotify's semantics (insert_before counts positions before the move)", () => {
    expect(simulate([..."abcde"], [{ op: "move", range_start: 0, insert_before: 3, range_length: 1 }])).toEqual([..."bcade"]);
  });

  it("re-inserts kept occurrences of a removed URI", () => {
    const [a, b, c] = ["spotify:track:a", "spotify:track:b", "spotify:track:c"];
    const before = [a, b, a, c, a];
    const ops = computeRemoveOperations(before, new Set([2]));
    expect(ops[0]).toEqual({ op: "delete_uris", uris: [a] });
    expect(simulate(before, ops)).toEqual([a, b, c, a]);
  });

  it("computes the order after a move", () => {
    expect(orderFromMove(5, 4, 1)).toEqual([0, 4, 1, 2, 3]);
    expect(() => orderFromMove(5, 5, 0)).toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
  });
});

// --- Build / apply flow against the fake API -------------------------------------------------------------

function setup(options: { lag?: boolean; writeLog?: boolean; items?: number } = {}) {
  const fixture = buildFixture();
  const spotify = new FakeSpotify(fixture);
  spotify.lag = Boolean(options.lag);
  const log = options.writeLog === false ? null : new WriteLog(new MemoryStore());
  const client = new SpotifyClient({ accessToken: async () => "token" }, { fetch: spotify.fetch, sleep: noSleep, writeLog: log });
  // A plain playlist of distinct tracks, like curatune's FakeSpotify([track_uri(i) for i in range(8)]).
  const trackIds = [...fixture.tracks.keys()].slice(0, 20);
  const plain: FakePlaylist = {
    id: fakeId("playlist:plain"),
    name: "Plain",
    description: "",
    ownerId: fixture.userId,
    ownerName: fixture.displayName,
    public: true,
    items: trackIds.slice(0, options.items ?? 8),
    snapshotId: fakeId("snapshot:plain"),
  };
  fixture.playlists.push(plain);
  const backups = new MemoryStore();
  const uris = () => plain.items.map((id) => `spotify:track:${id}`);
  return { fixture, spotify, client, backups, plain, trackIds, uris, log, ids: fixture.ids };
}

describe("item plans", () => {
  it("building does not write; applying verifies, backs up, and records the outcome", async () => {
    const { client, spotify, backups, plain, uris } = setup();
    const start = uris();
    const newOrder = [0, 6, 1, 2, 7, 3, 4, 5];
    const plan = await buildReorderPlan(client, plain.id, { newOrder }, "test");
    expect(spotify.writes).toEqual([]);
    expect(plan.reason).toBe("test");

    const result = await applyPlan(client, plan, backups);
    expect(result.verified).toBe(true);
    expect(uris()).toEqual(newOrder.map((i) => start[i]));
    expect(await backups.keys()).toHaveLength(1);
    expect(plan.applied?.verified).toBe(true);
  });

  it("aborts without writing when the playlist changed", async () => {
    const { client, spotify, backups, plain, trackIds } = setup();
    const plan = await buildRemovePlan(client, plain.id, [1]);
    spotify.externalEdit(plain.id, (p) => p.items.push(trackIds[15]!));
    spotify.writes.length = 0;
    const err = await fail(applyPlan(client, plan, backups));
    expect(err.code).toBe("SNAPSHOT_MISMATCH");
    expect(err.details.items_changed).toBe(true);
    expect(spotify.writes).toEqual([]);
  });

  it("rejects a tampered plan (checksum)", async () => {
    const { client, spotify, backups, plain, uris } = setup();
    const plan = await buildRemovePlan(client, plain.id, [1]);
    (plan.operations[0] as { uris: string[] }).uris = [uris()[5]!];
    expect((await fail(applyPlan(client, plan, backups))).code).toBe("PLAN_CHECKSUM_MISMATCH");
    expect(spotify.writes).toEqual([]);
  });

  const removeTampering: [string, (p: ItemPlan) => void][] = [
    ["shows removing position 3 while the operations remove position 1", (p) => Object.assign(p.changes.remove![0]!, { position: 3, uri: p.before[3]!.uri })],
    ["claims an extra removal", (p) => p.changes.remove!.push({ ...p.before[5]! })],
    ["after no longer traces back to before", (p) => (p.after[0]!.from_position = 4)],
  ];
  for (const [label, mutate] of removeTampering) {
    it(`rejects a remove plan whose description does not match its operations: ${label}`, async () => {
      const { client, spotify, backups, plain } = setup();
      const plan = await buildRemovePlan(client, plain.id, [1]);
      mutate(plan);
      expect((await fail(applyPlan(client, plan, backups))).code).toBe("PLAN_INCONSISTENT");
      expect(spotify.writes).toEqual([]);
    });
  }

  const reorderTampering: [string, (p: ItemPlan) => void][] = [
    ["new_order shows the identity", (p) => (p.changes.new_order = range(p.before.length))],
    ["a listed move differs from the operation", (p) => (p.changes.moves![0]!.insert_before = 7)],
  ];
  for (const [label, mutate] of reorderTampering) {
    it(`rejects a reorder plan whose description does not match its operations: ${label}`, async () => {
      const { client, spotify, backups, plain } = setup();
      const plan = await buildReorderPlan(client, plain.id, { newOrder: [7, 0, 1, 2, 3, 4, 5, 6] });
      mutate(plan);
      expect((await fail(applyPlan(client, plan, backups))).code).toBe("PLAN_INCONSISTENT");
      expect(spotify.writes).toEqual([]);
    });
  }

  it("refuses to apply a plan twice", async () => {
    const { client, backups, plain } = setup();
    const plan = await buildRemovePlan(client, plain.id, [0]);
    await applyPlan(client, plan, backups);
    expect((await fail(applyPlan(client, plan, backups))).code).toBe("PLAN_ALREADY_APPLIED");
  });

  it("removes one occurrence of a duplicated URI and re-inserts the others", async () => {
    const { client, backups, plain, trackIds } = setup();
    const [a, b] = [trackIds[0]!, trackIds[1]!];
    plain.items = [a, b, a, b];
    const plan = await buildRemovePlan(client, plain.id, [2]);
    expect(plan.warnings[0]!.code).toBe("REINSERTED_DUPLICATES");
    expect((await applyPlan(client, plan, backups)).verified).toBe(true);
    expect(plain.items).toEqual([a, b, b]);
  });

  it("de-duplicates the Bebop test playlist, keeping the other edition (same ISRC, other URI)", async () => {
    const { client, backups, fixture, ids } = setup();
    const bebop = fixture.playlists.find((p) => p.id === ids.bebop)!;
    const plan = await buildRemovePlan(client, ids.bebop!, [6]); // track 7: the second copy of Ko-Ko
    expect(plan.changes.remove!.map((i) => i.name)).toEqual(["Ko-Ko"]);
    await applyPlan(client, plan, backups);
    expect(bebop.items).toHaveLength(11);
    expect(bebop.items.filter((id) => id === ids.koko)).toHaveLength(1);
    expect(bebop.items.indexOf(ids.koko!)).toBe(1);
    expect(bebop.items).toContain(ids.koko2);
  });

  it("rejects an identity reorder", async () => {
    const { client, plain } = setup();
    expect((await fail(buildReorderPlan(client, plain.id, { newOrder: range(8) }))).code).toBe("NO_CHANGES");
  });

  it("rejects invalid positions and orders", async () => {
    const { client, plain } = setup();
    expect((await fail(buildRemovePlan(client, plain.id, []))).code).toBe("PLAN_INVALID");
    expect((await fail(buildRemovePlan(client, plain.id, [1, 1]))).code).toBe("PLAN_INVALID");
    expect((await fail(buildRemovePlan(client, plain.id, [8]))).code).toBe("PLAN_INVALID");
    expect((await fail(buildReorderPlan(client, plain.id, { newOrder: [0, 1, 2] }))).code).toBe("PLAN_INVALID");
    expect((await fail(buildReorderPlan(client, plain.id, { newOrder: [0, 0, 1, 2, 3, 4, 5, 6] }))).code).toBe("PLAN_INVALID");
    expect((await fail(buildReorderPlan(client, plain.id, {}))).code).toBe("PLAN_INVALID");
  });

  it("refuses playlists the user does not own", async () => {
    const { client, ids } = setup();
    expect((await fail(buildRemovePlan(client, ids.lofi!, [0]))).code).toBe("FORBIDDEN");
  });

  it("moves one track", async () => {
    const { client, backups, plain, uris } = setup();
    const start = uris();
    const plan = await buildReorderPlan(client, plain.id, { move: [7, 0] });
    await applyPlan(client, plan, backups);
    expect(uris()).toEqual([start[7], ...start.slice(0, 7)]);
  });

  it("reorders a long playlist with range moves of at most 100", async () => {
    const { client, backups, plain, fixture, ids } = setup();
    plain.items = fixture.playlists.find((p) => p.id === ids.big)!.items.slice(); // 150 distinct tracks
    const newOrder = [...range(150).slice(120), ...range(120)]; // move the last 30 to the front
    const plan = await buildReorderPlan(client, plain.id, { newOrder });
    expect(plan.operations.every((op) => op.op === "move" && op.range_length <= 100)).toBe(true);
    expect((await applyPlan(client, plan, backups)).verified).toBe(true);
  });

  it("reports whether a plan is still applicable", async () => {
    const { client, spotify, plain, trackIds } = setup();
    const plan = await buildRemovePlan(client, plain.id, [0]);
    expect((await checkPlan(client, plan)).applicable).toBe(true);
    spotify.externalEdit(plain.id, (p) => p.items.push(trackIds[19]!));
    expect(await checkPlan(client, plan)).toMatchObject({ applicable: false, same_items: false });
  });
});

// --- Snapshot read lag -------------------------------------------------------------------------------------

describe("snapshot read lag", () => {
  it("add, then plan, then apply while reads lag", async () => {
    const { client, spotify, backups, plain, trackIds } = setup({ lag: true, items: 4 });
    await addItems(client, plain.id, [`spotify:track:${trackIds[10]}`]);
    const written = plain.snapshotId;

    const state = await getPlaylist(client, plain.id);
    expect(state.playlist.snapshot_id).toBe(written);
    expect(state.warnings[0]!.code).toBe("SNAPSHOT_READ_LAG");

    const plan = await buildReorderPlan(client, plain.id, { move: [4, 0] });
    expect(plan.playlist.snapshot_id).toBe(written);
    const result = await applyPlan(client, plan, backups);
    expect(result.verified).toBe(true);
    expect(result.snapshot_id).toBe(plain.snapshotId); // the write's snapshot, not the stale read
    expect(spotify.lag).toBe(true);
  });

  it("a plan built during lag still applies after reads converge", async () => {
    // The exact failure seen live by curatune: plan built during lag, applied after convergence.
    const { client, spotify, backups, plain, trackIds } = setup({ lag: true, items: 4 });
    await addItems(client, plain.id, [`spotify:track:${trackIds[10]}`]);
    const plan = await buildRemovePlan(client, plain.id, [0]);
    spotify.propagate();
    expect((await applyPlan(client, plan, backups)).verified).toBe(true);
  });

  it("without a write log, lag causes a mismatch", async () => {
    const { client, spotify, backups, plain, trackIds } = setup({ lag: true, items: 4, writeLog: false });
    await addItems(client, plain.id, [`spotify:track:${trackIds[10]}`]);
    const plan = await buildRemovePlan(client, plain.id, [0]);
    spotify.propagate();
    expect((await fail(applyPlan(client, plan, backups))).code).toBe("SNAPSHOT_MISMATCH");
  });

  it("an external item change after our write is still rejected", async () => {
    const { client, spotify, backups, plain, trackIds } = setup({ lag: true, items: 4 });
    await addItems(client, plain.id, [`spotify:track:${trackIds[10]}`]);
    const plan = await buildRemovePlan(client, plain.id, [0]);
    spotify.externalEdit(plain.id, (p) => p.items.push(trackIds[19]!)); // someone edits in the Spotify app
    spotify.writes.length = 0;
    const err = await fail(applyPlan(client, plan, backups));
    expect(err.code).toBe("SNAPSHOT_MISMATCH");
    expect(err.details.items_changed).toBe(true);
    expect(spotify.writes).toEqual([]);
  });

  it("expires stale entries", async () => {
    const log = new WriteLog(new MemoryStore(), -1);
    await log.record("p", "snap-new", ["a"]);
    expect(await log.resolve("p", "snap-old", ["a"])).toEqual(["snap-old", false]);
  });

  it("drops an entry once reads converge", async () => {
    const log = new WriteLog(new MemoryStore());
    await log.record("p", "snap-new", ["a"]);
    expect(await log.resolve("p", "snap-old", ["a"])).toEqual(["snap-new", true]);
    expect(await log.resolve("p", "snap-new", ["a"])).toEqual(["snap-new", false]);
    expect(await log.resolve("p", "snap-old", ["a"])).toEqual(["snap-old", false]);
  });
});

// --- Playlist list lag (curatune 590cd87) --------------------------------------------------------------------

describe("playlist list lag", () => {
  it("lists the count our recent write left while Spotify's list still has the old total", async () => {
    const { client, plain, log, trackIds } = setup();
    // As after adding two tracks: the write log expects 10 items, the list still says 8.
    await log!.record(plain.id, "snap-after-add", trackIds.slice(0, 10).map((id) => `spotify:track:${id}`));
    const data = await listPlaylists(client);
    expect(data.playlists.find((p) => p.id === plain.id)!.item_count).toBe(10);
    expect(data.warnings).toEqual([
      expect.objectContaining({ code: "ITEM_COUNT_READ_LAG", playlists: [{ playlist_id: plain.id, listed_item_count: 8, item_count: 10 }] }),
    ]);
  });

  it("leaves the list alone once it agrees, for expired entries, and without a write log", async () => {
    const agrees = setup();
    await agrees.log!.record(agrees.plain.id, "snap", agrees.uris());
    expect((await listPlaylists(agrees.client)).warnings).toEqual([]);

    const expired = setup();
    const old = new WriteLog(new MemoryStore(), -1);
    await old.record(expired.plain.id, "snap", ["spotify:track:x"]);
    expect(await old.expectedCounts()).toEqual(new Map());

    const none = setup({ writeLog: false });
    const data = await listPlaylists(none.client);
    expect(data.playlists.find((p) => p.id === none.plain.id)!.item_count).toBe(8);
    expect(data.warnings).toEqual([]);
  });
});

// --- Details (name, description) ---------------------------------------------------------------------------

describe("details plans", () => {
  function detailsSetup() {
    const ctx = setup({ items: 3 });
    ctx.plain.name = "Old name";
    ctx.plain.description = "Old description";
    return ctx;
  }

  it("lists only changed fields and touches nothing", async () => {
    const { client, spotify, plain } = detailsSetup();
    const plan = await buildDetailsPlan(client, plain.id, { name: "New name", description: "Old description" });
    expect(spotify.writes).toEqual([]);
    expect(plan.changes).toEqual({ name: { from: "Old name", to: "New name" } });
    expect(plan.operations).toEqual([{ op: "set_details", fields: { name: "New name" } }]);
  });

  it("renames and redescribes, sending only name and description, and verifies", async () => {
    const { client, spotify, backups, plain } = detailsSetup();
    const plan = await buildDetailsPlan(client, plain.id, { name: "New name", description: "Fans' favourites & deep cuts" });
    const result = await applyPlan(client, plan, backups);
    expect(result.verified).toBe(true);
    expect(result.warnings).toEqual([]);
    expect([plain.name, plain.description]).toEqual(["New name", "Fans' favourites & deep cuts"]);
    expect(spotify.writes).toEqual([{ method: "PUT", path: `/v1/playlists/${plain.id}`, body: { name: "New name", description: "Fans' favourites & deep cuts" } }]);
    expect(plan.applied?.verified).toBe(true);
  });

  it("compares descriptions unescaped", async () => {
    const { client, plain } = detailsSetup();
    plain.description = "Rock & Roll's roots"; // served HTML-escaped by the fake, like Spotify does
    expect((await fail(buildDetailsPlan(client, plain.id, { description: "Rock & Roll's roots" }))).code).toBe("NO_CHANGES");
  });

  it("refuses to apply if the field changed meanwhile", async () => {
    const { client, spotify, backups, plain } = detailsSetup();
    const plan = await buildDetailsPlan(client, plain.id, { description: "Planned" });
    plain.description = "Edited in the app";
    expect((await fail(applyPlan(client, plan, backups))).code).toBe("SNAPSHOT_MISMATCH");
    expect(spotify.writes).toEqual([]);
  });

  it("is not blocked by item changes", async () => {
    const { client, spotify, backups, plain, trackIds } = detailsSetup();
    const plan = await buildDetailsPlan(client, plain.id, { name: "New name" });
    spotify.externalEdit(plain.id, (p) => p.items.push(trackIds[9]!));
    expect((await applyPlan(client, plan, backups)).verified).toBe(true);
  });

  it("reports an ignored change instead of claiming it", async () => {
    const { client, spotify, backups, plain } = detailsSetup();
    spotify.ignoreDetails = true;
    const plan = await buildDetailsPlan(client, plain.id, { name: "New name" });
    const result = await applyPlan(client, plan, backups);
    expect(result.verified).toBe(false);
    expect(result.warnings[0]!.code).toBe("DETAILS_NOT_CONFIRMED");
    expect(result.current).toEqual({ name: "Old name" });
  });

  it("warns about a duplicate name", async () => {
    const { client, plain } = detailsSetup();
    const plan = await buildDetailsPlan(client, plain.id, { name: "bebop TEST" });
    expect(plan.warnings[0]!.code).toBe("DUPLICATE_NAME");
  });

  it("rejects invalid requests", async () => {
    const { client, plain } = detailsSetup();
    expect((await fail(buildDetailsPlan(client, plain.id, {}))).code).toBe("PLAN_INVALID");
    expect((await fail(buildDetailsPlan(client, plain.id, { name: "  " }))).code).toBe("PLAN_INVALID");
    expect((await fail(buildDetailsPlan(client, plain.id, { name: "Old name" }))).code).toBe("NO_CHANGES");
  });

  it("cannot smuggle visibility into a plan, even with a recomputed checksum", async () => {
    const { client, spotify, backups, plain } = detailsSetup();
    const plan = await buildDetailsPlan(client, plain.id, { name: "New name" });
    // Deliberately outside the types: this is what a forged plan would look like.
    const forged = plan as unknown as { before: Record<string, unknown>; after: Record<string, unknown>; changes: Record<string, unknown>; operations: { fields: Record<string, unknown> }[] };
    forged.before.public = true;
    forged.after.public = false;
    forged.operations[0]!.fields.public = false;
    forged.changes.public = { from: true, to: false };
    plan.checksum = await planChecksum(plan); // a deliberate forgery, not an accidental edit
    expect((await fail(applyPlan(client, plan as Plan, backups))).code).toBe("PLAN_INCONSISTENT");
    expect(spotify.writes).toEqual([]);
  });

  it("setDetails rejects any field but name and description", async () => {
    const { client, plain } = detailsSetup();
    await expect(setDetails(client, plain.id, { public: false } as never)).rejects.toThrow(/only accepts/);
  });

  it("reports applicability", async () => {
    const { client, plain } = detailsSetup();
    const plan = await buildDetailsPlan(client, plain.id, { description: "Planned" });
    expect((await checkPlan(client, plan)).applicable).toBe(true);
    plain.description = "Edited in the app";
    expect(await checkPlan(client, plan)).toMatchObject({ applicable: false, current: { description: "Edited in the app" } });
  });
});

describe("validatePlan", () => {
  it("accepts the plans it builds", async () => {
    const { client, plain } = setup();
    await validatePlan(await buildRemovePlan(client, plain.id, [2, 5]));
    await validatePlan(await buildReorderPlan(client, plain.id, { move: [0, 7] }));
    await validatePlan(await buildDetailsPlan(client, plain.id, { name: "X" }));
  });

  it("rejects missing fields and unknown kinds", async () => {
    const { client, plain } = setup();
    const plan = await buildRemovePlan(client, plain.id, [1]);
    const { checksum: _checksum, ...withoutChecksum } = plan;
    expect((await fail(validatePlan(withoutChecksum as Plan))).code).toBe("PLAN_INVALID");
    expect((await fail(validatePlan({ ...plan, kind: "delete" } as unknown as Plan))).code).toBe("PLAN_INVALID");
  });
});
