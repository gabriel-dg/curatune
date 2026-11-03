import { describe, expect, it } from "vitest";
import { applyPlan, validatePlan, type Plan } from "../src/plans/plans";
import { SpotifyClient } from "../src/spotify/http";
import { MemoryStore } from "../src/storage/kv";
import { ALL_TOOLS, executeTool, PLAN_TOOLS } from "../src/tools";
import { buildFixture, FakeSpotify } from "./fake-spotify";
import { noSleep } from "./helpers";

function setup() {
  const fixture = buildFixture();
  const spotify = new FakeSpotify(fixture);
  const client = new SpotifyClient({ accessToken: async () => "token" }, { fetch: spotify.fetch, sleep: noSleep });
  const plans: Plan[] = [];
  const run = (name: string, args: unknown, known = true) =>
    executeTool(ALL_TOOLS, name, JSON.stringify(args), { client, onPlan: (p) => plans.push(p), isKnownId: () => known });
  const bebop = fixture.playlists.find((p) => p.id === fixture.ids.bebop)!;
  return { fixture, spotify, client, plans, run, bebop, ids: fixture.ids };
}

describe("plan tools", () => {
  it("are plan_remove, plan_reorder, and plan_details", () => {
    expect(PLAN_TOOLS.map((t) => t.name)).toEqual(["plan_remove", "plan_reorder", "plan_details"]);
  });

  it("plan_remove takes 1-based numbers, registers the plan, writes nothing, and says who applies it", async () => {
    const { run, plans, spotify, ids } = setup();
    const execution = await run("plan_remove", { playlist_id: ids.bebop, numbers: [7], reason: "exact duplicate of track 2" });
    expect(execution.outcome.ok).toBe(true);
    const result = (execution.outcome as { result: any }).result;
    expect(result.remove).toEqual([{ number: 7, name: "Ko-Ko", artists: ["Charlie Parker"] }]);
    expect([result.tracks_before, result.tracks_after]).toEqual([12, 11]);
    expect(result.next_step).toMatch(/cannot apply/);
    expect(result.warnings.map((w: { code: string }) => w.code)).toEqual(["REINSERTED_DUPLICATES"]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.kind).toBe("remove");
    expect((plans[0] as { changes: { remove: { position: number }[] } }).changes.remove[0]!.position).toBe(6);
    expect(plans[0]!.reason).toBe("exact duplicate of track 2");
    expect(execution.write).toBeNull();
    expect(spotify.writes).toEqual([]);
  });

  it("plan_reorder takes the full order as numbers", async () => {
    const { run, plans, bebop, client } = setup();
    const order = [12, ...Array.from({ length: 11 }, (_, i) => i + 1)];
    const execution = await run("plan_reorder", { playlist_id: bebop.id, order });
    const result = (execution.outcome as { result: any }).result;
    expect(result.new_order[0]).toMatchObject({ number: 1, was: 12, name: "Woody'n You" });
    expect(result.operations).toBe(1);
    await validatePlan(plans[0]!);
    // Applying it (as the UI would) gives the proposed order.
    const before = [...bebop.items];
    await applyPlan(client, plans[0]!, new MemoryStore());
    expect(bebop.items).toEqual([before[11], ...before.slice(0, 11)]);
  });

  it("plan_reorder moves one track", async () => {
    const { run, plans, bebop } = setup();
    const execution = await run("plan_reorder", { playlist_id: bebop.id, move_from: 1, move_to: 12 });
    expect(execution.outcome.ok).toBe(true);
    expect((plans[0] as { changes: { new_order: number[] } }).changes.new_order).toEqual([...Array.from({ length: 11 }, (_, i) => i + 1), 0]);
  });

  it("plan_reorder sorts by title in code: leading punctuation ignored, ties stable", async () => {
    const { run, plans, ids } = setup();
    const execution = await run("plan_reorder", { playlist_id: ids.bebop, sort_by: "title" });
    expect(execution.outcome.ok).toBe(true);
    const names = (plans[0] as { after: { name: string; from_position: number }[] }).after.map((a) => `${a.name}#${a.from_position + 1}`);
    expect(names).toEqual([
      "Boplicity#8",
      "Ko-Ko#2",
      "Ko-Ko#7",
      "Ko-Ko#11",
      "Lady Bird#10",
      "Manteca#4",
      "'Round Midnight#3",
      "'Round Midnight#6",
      "Salt Peanuts#9",
      "Swing to Bop#5",
      "Un Poco Loco - Remastered 1998/Rudy Van Gelder Edition#1",
      "Woody'n You#12",
    ]);
  });

  it("plan_reorder sorts by duration, descending, and by edition date", async () => {
    const { run, plans, ids } = setup();
    await run("plan_reorder", { playlist_id: ids.bebop, sort_by: "duration", descending: true });
    expect((plans[0] as { after: { name: string }[] }).after[0]!.name).toBe("Swing to Bop");
    await run("plan_reorder", { playlist_id: ids.bebop, sort_by: "released" });
    expect((plans[1] as { after: { name: string }[] }).after.at(-1)!.name).toBe("Ko-Ko"); // the 2024 compilation
    expect((await run("plan_reorder", { playlist_id: ids.bebop, sort_by: "popularity" })).outcome).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });

  it("plan_reorder rejects mixed or incomplete arguments and bad orders", async () => {
    const { run, bebop, plans } = setup();
    for (const args of [
      { playlist_id: bebop.id },
      { playlist_id: bebop.id, move_from: 1 },
      { playlist_id: bebop.id, order: [2, 1], move_from: 1, move_to: 2 },
      { playlist_id: bebop.id, order: [2, 1] },
      { playlist_id: bebop.id, order: Array.from({ length: 12 }, (_, i) => i) },
    ]) {
      const execution = await run("plan_reorder", args);
      expect(execution.outcome.ok, JSON.stringify(args)).toBe(false);
    }
    expect(plans).toEqual([]);
  });

  it("plan_details proposes a rename and never touches visibility", async () => {
    const { run, plans, bebop } = setup();
    const execution = await run("plan_details", { playlist_id: bebop.id, name: "Bebop sandbox" });
    expect((execution.outcome as { result: any }).result.changes).toEqual({ name: { from: "Bebop test", to: "Bebop sandbox" } });
    expect(plans[0]!.operations).toEqual([{ op: "set_details", fields: { name: "Bebop sandbox" } }]);
    const smuggled = await run("plan_details", { playlist_id: bebop.id, public: false });
    expect(smuggled.outcome).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });

  it("refuses playlist ids that did not appear in the conversation", async () => {
    const { run, plans, ids } = setup();
    const execution = await run("plan_remove", { playlist_id: ids.bebop, numbers: [1] }, false);
    expect(execution.outcome).toMatchObject({ ok: false, error: { code: "INVALID_REFERENCE" } });
    expect(plans).toEqual([]);
  });

  it("reports builder errors to the model", async () => {
    const { run, ids } = setup();
    expect((await run("plan_remove", { playlist_id: ids.bebop, numbers: [13] })).outcome).toMatchObject({ ok: false, error: { code: "PLAN_INVALID" } });
    expect((await run("plan_remove", { playlist_id: ids.lofi, numbers: [1] })).outcome).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect((await run("plan_details", { playlist_id: ids.bebop, name: "Bebop test" })).outcome).toMatchObject({ ok: false, error: { code: "NO_CHANGES" } });
  });
});
