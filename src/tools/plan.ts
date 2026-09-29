// Plan tools (phase 4): the model proposes removals, reorders, and renames as plans. A tool only builds
// the plan (reading the playlist) and hands it to the UI through ctx.onPlan; the user reviews it and
// applies it with the UI's Apply button. There is deliberately no tool that applies a plan, and this
// module never imports applyPlan (tests/invariants.test.ts).

import { buildDetailsPlan, buildRemovePlan, buildReorderPlan, SORT_KEYS, type ItemPlan, type Plan, type SortKey } from "../plans/plans";
import { SpotikitError } from "../spotify/errors";
import { parseId } from "../spotify/refs";
import { numberedWarnings } from "./read";
import type { Args } from "./schema";
import type { Tool, ToolContext } from "./types";

const str = (args: Args, key: string) => args[key] as string | undefined;

const NEXT_STEP =
  "Proposed only: nothing has changed yet. The user sees this plan with an Apply button and decides. You " +
  "cannot apply it. Explain the plan and ask the user to review it and press Apply.";

function playlistIdFrom(args: Args, ctx: ToolContext): string {
  const id = parseId(str(args, "playlist_id")!, "playlist");
  if (ctx.isKnownId && !ctx.isKnownId(id)) {
    throw new SpotikitError("INVALID_REFERENCE", `The playlist id ${id} did not appear in this conversation. Get it from playlists_list.`);
  }
  return id;
}

function register(ctx: ToolContext, plan: Plan): void {
  ctx.onPlan?.(plan);
}

const playlistFields = (plan: Plan) => ({ id: plan.playlist.id, name: plan.playlist.name });
const who = (artists: string[]) => artists.filter(Boolean).join(", ");

const reasonParam = { type: "string" as const, description: "One sentence on why, shown to the user with the plan." };

const planRemove: Tool = {
  name: "plan_remove",
  description:
    "Propose removing tracks from a playlist the user owns, by their track numbers (as in playlist_show; 1 = " +
    "first track). Builds a plan for the user to review and apply; it does not change anything by itself.",
  parameters: {
    type: "object",
    properties: {
      playlist_id: { type: "string", description: "Playlist id from playlists_list.", minLength: 1 },
      numbers: { type: "array", description: "Track numbers to remove (1-based, from playlist_show).", items: { type: "integer" }, minItems: 1, maxItems: 500 },
      reason: reasonParam,
    },
    required: ["playlist_id", "numbers"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const playlistId = playlistIdFrom(args, ctx);
    const plan = await buildRemovePlan(ctx.client, playlistId, (args.numbers as number[]).map((n) => n - 1), str(args, "reason") ?? null);
    register(ctx, plan);
    return {
      plan_id: plan.plan_id,
      kind: plan.kind,
      playlist: playlistFields(plan),
      remove: (plan.changes.remove ?? []).map((i) => ({ number: i.position + 1, name: i.name, artists: i.artists })),
      tracks_before: plan.before.length,
      tracks_after: plan.after.length,
      warnings: numberedWarnings(plan.warnings),
      next_step: NEXT_STEP,
    };
  },
  summarize: (result) => `plan: remove ${(result as { remove: unknown[] }).remove.length}`,
};

const planReorder: Tool = {
  name: "plan_reorder",
  description:
    "Propose a new order for a playlist the user owns. Give exactly one of: `sort_by` (the app sorts by title, " +
    "artist, album, released, duration, or recorded; use it for any sort by those; \"recorded\" uses the stored " +
    "recording dates, see recordings_show), `order` (every current track number, " +
    "1-based, listed in the new order), or `move_from` and `move_to` (move one track so it ends up with that " +
    "number). Builds a plan for the user to review and apply; it does not change anything by itself.",
  parameters: {
    type: "object",
    properties: {
      playlist_id: { type: "string", description: "Playlist id from playlists_list.", minLength: 1 },
      order: {
        type: "array",
        description: "All current track numbers in their new order; each exactly once. Example for 4 tracks: [3, 1, 2, 4].",
        items: { type: "integer" },
        minItems: 2,
        maxItems: 10_000,
      },
      move_from: { type: "integer", description: "Current number of the track to move.", minimum: 1 },
      move_to: { type: "integer", description: "Number the moved track will have (1 = first).", minimum: 1 },
      sort_by: {
        type: "string",
        description: `Sort key: ${[...SORT_KEYS, "recorded"].join(", ")}. "released" is the edition's date; "recorded" is the stored recording date (every track needs one). Ties keep their current order.`,
      },
      descending: { type: "boolean", description: "With sort_by: Z to A, newest first, or longest first. Default false." },
      reason: reasonParam,
    },
    required: ["playlist_id"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const playlistId = playlistIdFrom(args, ctx);
    const order = args.order as number[] | undefined;
    const from = args.move_from as number | undefined;
    const to = args.move_to as number | undefined;
    const sortBy = str(args, "sort_by");
    const hasMove = from !== undefined || to !== undefined;
    if ([order !== undefined, hasMove, sortBy !== undefined].filter(Boolean).length !== 1 || (hasMove && (from === undefined || to === undefined))) {
      throw new SpotikitError("INVALID_ARGUMENT", "Give exactly one of sort_by, order, or both move_from and move_to.");
    }
    if (sortBy !== undefined && sortBy !== "recorded" && !(SORT_KEYS as readonly string[]).includes(sortBy)) {
      throw new SpotikitError("INVALID_ARGUMENT", `sort_by must be one of: ${[...SORT_KEYS, "recorded"].join(", ")}.`);
    }
    if (sortBy === "recorded" && !ctx.recordings) throw new SpotikitError("INVALID_ARGUMENT", "Recording dates are not available.");
    const options =
      sortBy === "recorded"
        ? { recordings: await ctx.recordings!.load() }
        : sortBy
          ? { sortBy: sortBy as SortKey, descending: Boolean(args.descending) }
          : order
            ? { newOrder: order.map((n) => n - 1) }
            : { move: [from! - 1, to! - 1] as [number, number] };
    let plan: ItemPlan;
    try {
      plan = await buildReorderPlan(ctx.client, playlistId, options, str(args, "reason") ?? null);
    } catch (exc) {
      // Missing dates: tell the model which tracks (by number) so it can store them and retry.
      if (exc instanceof SpotikitError && exc.code === "RECORDING_DATES_MISSING") {
        const missing = (exc.details.missing as { position: number; name: string | null }[]).map((m) => `${m.position + 1}. ${m.name}`);
        throw new SpotikitError("RECORDING_DATES_MISSING", `No recording date for: ${missing.join("; ")}. Store them with recordings_set, then retry.`);
      }
      throw exc;
    }
    register(ctx, plan);
    return {
      plan_id: plan.plan_id,
      kind: plan.kind,
      playlist: playlistFields(plan),
      new_order: plan.after.map((a) => ({ number: a.position + 1, was: a.from_position + 1, name: a.name, artists: who(a.artists) })),
      operations: plan.operations.length,
      warnings: numberedWarnings(plan.warnings),
      next_step: NEXT_STEP,
    };
  },
  summarize: (result) => `plan: reorder (${(result as { operations: number }).operations} moves)`,
};

const planDetails: Tool = {
  name: "plan_details",
  description:
    "Propose renaming a playlist the user owns and/or changing its description. Only when the user asked for it. " +
    "Visibility cannot be changed. Builds a plan for the user to review and apply; it does not change anything by itself.",
  parameters: {
    type: "object",
    properties: {
      playlist_id: { type: "string", description: "Playlist id from playlists_list.", minLength: 1 },
      name: { type: "string", description: "New name." },
      description: { type: "string", description: "New description (an empty string clears it)." },
      reason: reasonParam,
    },
    required: ["playlist_id"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const playlistId = playlistIdFrom(args, ctx);
    const plan = await buildDetailsPlan(ctx.client, playlistId, { name: str(args, "name"), description: str(args, "description") }, str(args, "reason") ?? null);
    register(ctx, plan);
    return { plan_id: plan.plan_id, kind: plan.kind, playlist: playlistFields(plan), changes: plan.changes, warnings: plan.warnings, next_step: NEXT_STEP };
  },
  summarize: (result) => `plan: ${Object.keys((result as { changes: object }).changes).join(" and ")}`,
};

export const PLAN_TOOLS: Tool[] = [planRemove, planReorder, planDetails];
