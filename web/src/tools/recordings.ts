// Recording-date tools: show a playlist joined with the stored dates, and store dates. Dates are kept in
// this browser (IndexedDB), not in Spotify, so storing them needs no plan; the UI still shows each save.
// Ordering by recording date is plan_reorder with sort_by "recorded".

import { CONFIDENCE_LEVELS, playlistRecordings } from "../recordings/recordings";
import { CuratuneError } from "../spotify/errors";
import { normalizeItemUri, parseId } from "../spotify/refs";
import type { Args } from "./schema";
import { THIRD_PARTY_NOTE, type Tool, type ToolContext } from "./types";
import { requireKnownIds } from "./write";

const MAX_ENTRIES = 100;

function store(ctx: ToolContext) {
  if (!ctx.recordings) throw new CuratuneError("INVALID_ARGUMENT", "Recording dates are not available.");
  return ctx.recordings;
}

const recordingsShow: Tool = {
  name: "recordings_show",
  description:
    "Show a playlist's tracks (by number) with their stored recording dates, the tracks that have none, and " +
    "whether the playlist is already in chronological order of recording. Only playlists the user owns." + THIRD_PARTY_NOTE,
  parameters: {
    type: "object",
    properties: { playlist_id: { type: "string", description: "Playlist id from playlists_list.", minLength: 1 } },
    required: ["playlist_id"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const result = await playlistRecordings(ctx.client, store(ctx), args.playlist_id as string);
    return {
      playlist: { id: result.playlist.id, name: result.playlist.name },
      items: result.items.map((i) => ({
        number: i.position + 1,
        uri: i.uri,
        name: i.name,
        artists: i.artists,
        recorded: i.recording?.recorded ?? null,
        confidence: i.recording?.confidence ?? null,
      })),
      missing: result.missing.map((m) => ({ number: m.position + 1, uri: m.uri, name: m.name })),
      chronological: result.chronological,
    };
  },
  summarize: (result) => {
    const r = result as { items: unknown[]; missing: unknown[]; chronological: boolean };
    return `${r.items.length - r.missing.length}/${r.items.length} dated${r.chronological ? ", chronological" : ""}`;
  },
};

const recordingsSet: Tool = {
  name: "recordings_set",
  description:
    "Store recording dates for tracks (kept in this browser, used by plan_reorder with sort_by \"recorded\"). " +
    "Give each track's uri, the date (YYYY, YYYY-MM, or YYYY-MM-DD), your confidence (high, medium, low), and " +
    "the source: say \"model knowledge\" when the date comes from what you know, and use high only when sure.",
  parameters: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        description: 'e.g. [{"uri": "spotify:track:…", "recorded": "1947-12-30", "confidence": "medium", "source": "model knowledge"}]',
        items: {
          type: "object",
          properties: {
            uri: { type: "string", description: "Track URI from a tool result." },
            recorded: { type: "string", description: "YYYY, YYYY-MM, or YYYY-MM-DD." },
            confidence: { type: "string", description: CONFIDENCE_LEVELS.join(", ") },
            source: { type: "string", description: "Where the date comes from." },
            note: { type: "string", description: "Optional, e.g. which take or session." },
            name: { type: "string", description: "Optional track name." },
          },
          additionalProperties: false,
        },
        minItems: 1,
        maxItems: MAX_ENTRIES,
      },
    },
    required: ["entries"],
    additionalProperties: false,
  },
  async run(args: Args, ctx) {
    const entries = args.entries as Record<string, string>[];
    requireKnownIds(ctx, entries.map((e) => parseId(normalizeItemUri(e.uri ?? ""), "track")));
    const result = await store(ctx).upsert(entries);
    return { ...result, saved: entries.map((e) => ({ uri: normalizeItemUri(e.uri!), name: e.name ?? null, recorded: e.recorded, confidence: e.confidence })) };
  },
  summarize: (result) => {
    const r = result as { created: number; updated: number };
    return `saved ${r.created + r.updated} dates`;
  },
  describeWrite: (result) => {
    const r = result as { saved: { uri: string; name: string | null; recorded: string; confidence: string }[] };
    return {
      title: `Saved ${r.saved.length} recording date${r.saved.length === 1 ? "" : "s"} (in this browser)`,
      lines: r.saved.map((s) => `${s.name ?? s.uri}: ${s.recorded} (${s.confidence})`),
      playlistId: null,
      warnings: [],
    };
  },
};

export const RECORDING_TOOLS: Tool[] = [recordingsShow, recordingsSet];
