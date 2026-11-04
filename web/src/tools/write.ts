// Write tools: create a playlist, add tracks. Both run directly, as in curatune, and the UI
// shows every write. Removing, reordering, and renaming go only through plans (plan.ts); visibility is
// never changeable. IDs must come from the conversation: the model cannot write invented ones.

import { CuratuneError } from "../spotify/errors";
import { normalizeItemUri, parseId } from "../spotify/refs";
import { addItems, createPlaylist, MAX_URIS_PER_REQUEST } from "../spotify/writes";
import type { Args } from "./schema";
import type { Tool, ToolContext } from "./types";

const str = (args: Args, key: string) => args[key] as string | undefined;

export function requireKnownIds(ctx: ToolContext, ids: string[]): void {
  if (!ctx.isKnownId) return;
  const unknown = [...new Set(ids.filter((id) => !ctx.isKnownId!(id)))];
  if (unknown.length) {
    throw new CuratuneError(
      "INVALID_REFERENCE",
      `These IDs did not appear in this conversation: ${unknown.join(", ")}. Use ids and URIs taken from tool ` +
        "results (for example search_tracks) or from the user's messages; never write invented ones.",
      { unknown },
    );
  }
}

const playlistCreate: Tool = {
  name: "playlist_create",
  description:
    "Create a new, empty playlist for the user. Only when the user asks for a new playlist. Spotify makes it " +
    "public even though it is requested as private: tell the user. Fails with DUPLICATE_NAME if the user " +
    "already owns a playlist with that name; then ask the user before retrying with allow_duplicate_name.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Playlist name.", minLength: 1 },
      description: { type: "string", description: "Optional description." },
      allow_duplicate_name: {
        type: "boolean",
        description: "Create it even if the user owns a playlist with the same name. Only after the user confirmed.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async run(args, { client }) {
    const result = await createPlaylist(client, str(args, "name")!, str(args, "description") ?? "", Boolean(args.allow_duplicate_name));
    return {
      playlist: { id: result.playlist.id, name: result.playlist.name, public: result.playlist.public, items: 0 },
      warnings: result.warnings,
    };
  },
  summarize: (result) => `created ${(result as { playlist: { name: string } }).playlist.name}`,
  describeWrite: (result) => {
    const r = result as { playlist: { id: string; name: string; public: boolean | null }; warnings: { message: string }[] };
    return {
      title: `Created playlist "${r.playlist.name}"`,
      lines: [r.playlist.public === false ? "Reported as private." : "Public (Spotify ignores private on creation)."],
      playlistId: r.playlist.id,
      warnings: [],
      itemCount: 0,
    };
  },
};

const playlistAdd: Tool = {
  name: "playlist_add",
  description:
    "Add tracks to a playlist the user owns or collaborates on. Only when the user asks for it. Use track " +
    "URIs from search_tracks, album_tracks, or track_show results, or given by the user. Appends at the end " +
    "unless at_number is given. Tracks already in the playlist are skipped unless allow_duplicates.",
  parameters: {
    type: "object",
    properties: {
      playlist_id: { type: "string", description: "Playlist id from playlists_list or playlist_create.", minLength: 1 },
      track_uris: {
        type: "array",
        description: `Track URIs (spotify:track:…), in the order to add them. At most ${MAX_URIS_PER_REQUEST}.`,
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_URIS_PER_REQUEST,
      },
      at_number: {
        type: "integer",
        description: "Track number the first added track will have (1 = at the start). Default: at the end.",
        minimum: 1,
      },
      allow_duplicates: { type: "boolean", description: "Add tracks even if already in the playlist. Default false." },
    },
    required: ["playlist_id", "track_uris"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const playlistId = parseId(str(args, "playlist_id")!, "playlist");
    const uris = (args.track_uris as string[]).map(normalizeItemUri);
    requireKnownIds(ctx, [playlistId, ...uris.map((uri) => uri.split(":")[2]!)]);
    const atNumber = args.at_number as number | undefined;
    const result = await addItems(ctx.client, playlistId, uris, atNumber === undefined ? null : atNumber - 1, Boolean(args.allow_duplicates));
    const byPosition = new Map((result.items_after ?? []).map((item) => [item.position, item]));
    return {
      playlist: { id: result.playlist.id, name: result.playlist.name },
      added: result.added.map((a) => {
        const item = byPosition.get(a.position);
        return { number: a.position + 1, uri: a.uri, name: item?.name ?? null, artists: item?.artists.map((x) => x.name) ?? [] };
      }),
      skipped: result.skipped,
      item_count: result.item_count,
      verified: result.verified,
    };
  },
  summarize: (result) => {
    const r = result as { added: unknown[]; skipped: unknown[] };
    return `added ${r.added.length}${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}`;
  },
  describeWrite: (result) => {
    const r = result as {
      playlist: { id: string; name: string };
      added: { number: number; name: string | null; artists: string[]; uri: string }[];
      skipped: { uri: string; reason: string }[];
      item_count: number;
      verified: boolean;
    };
    if (!r.added.length) return null;
    return {
      title: `Added ${r.added.length} track${r.added.length === 1 ? "" : "s"} to "${r.playlist.name}" (now ${r.item_count})`,
      lines: [
        ...r.added.map((a) => `${a.number}. ${a.name ?? a.uri}${a.artists.length ? ` - ${a.artists.join(", ")}` : ""}`),
        ...r.skipped.map((s) => `Skipped ${s.uri}: ${s.reason.replace(/_/g, " ")}`),
      ],
      playlistId: r.playlist.id,
      warnings: r.verified ? [] : ["The re-read did not show the added tracks where expected; check the playlist."],
      itemCount: r.item_count,
    };
  },
};

export const WRITE_TOOLS: Tool[] = [playlistCreate, playlistAdd];
