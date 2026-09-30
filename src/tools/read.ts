// Read-only tools (phase 2): schemas for the model and handlers over src/spotify. No tool writes to
// Spotify; there is deliberately no tool that applies a plan (see AGENTS.md).

import { getAlbumTracks, getTrack, SEARCH_MAX_LIMIT, searchTracks } from "../spotify/catalog";
import { SpotikitError } from "../spotify/errors";
import { getPlaylist, listPlaylists, type Warning } from "../spotify/playlists";
import type { Args } from "./schema";
import { briefAlbum, briefAlbumTrack, briefItem, briefPlaylist, briefTrack, formatTotalDuration } from "./trim";
import type { Tool } from "./types";

export const PLAYLIST_PAGE_MAX = 100;
export const ALBUM_PAGE_MAX = 50;

function page<T>(items: T[], args: Args, max: number) {
  const offset = (args.offset as number | undefined) ?? 0;
  const limit = (args.limit as number | undefined) ?? max;
  const slice = items.slice(offset, offset + limit);
  return { offset, next_offset: offset + slice.length < items.length ? offset + slice.length : null, slice };
}

const str = (args: Args, key: string) => args[key] as string | undefined;

/** Warnings list 0-based positions; the model sees 1-based track numbers, like the items. */
export function numberedWarnings(warnings: Warning[]) {
  return warnings.map(({ positions, ...rest }) =>
    Array.isArray(positions) ? { ...rest, numbers: positions.map((p: number) => p + 1) } : rest,
  );
}

const playlistsList: Tool = {
  name: "playlists_list",
  description:
    "List the user's playlists: id, name, owner, and number of items. Use it to find a playlist's id from its name.",
  parameters: {
    type: "object",
    properties: {
      owned_only: { type: "boolean", description: "Only playlists the user owns. Default false." },
    },
    additionalProperties: false,
  },
  async run(args, { client }) {
    const data = await listPlaylists(client, Boolean(args.owned_only));
    return { count: data.count, playlists: data.playlists.map(briefPlaylist), ...(data.warnings.length ? { warnings: data.warnings } : {}) };
  },
  summarize: (result) => `${(result as { count: number }).count} playlists`,
};

const playlistShow: Tool = {
  name: "playlist_show",
  description:
    `Show a playlist and its items (number, uri, name, artists, album, released, duration, isrc). ` +
    `"number" is the track number the user sees in Spotify (1 = first track). Returns up to ` +
    `${PLAYLIST_PAGE_MAX} items per call; when next_offset is not null, call again with offset=next_offset ` +
    `for the rest. Only works for playlists the user owns or collaborates on.`,
  parameters: {
    type: "object",
    properties: {
      playlist_id: {
        type: "string",
        description: "Playlist id from playlists_list (a spotify:playlist: URI or open.spotify.com URL also works).",
        minLength: 1,
      },
      offset: { type: "integer", description: "How many items to skip. Default 0.", minimum: 0 },
      limit: {
        type: "integer",
        description: `Maximum items to return, 1-${PLAYLIST_PAGE_MAX}. Default ${PLAYLIST_PAGE_MAX}.`,
        minimum: 1,
        maximum: PLAYLIST_PAGE_MAX,
      },
    },
    required: ["playlist_id"],
    additionalProperties: false,
  },
  async run(args, { client }) {
    const state = await getPlaylist(client, str(args, "playlist_id")!);
    const totalMs = state.items.reduce((sum, i) => sum + (i.duration_ms ?? 0), 0);
    const { offset, next_offset, slice } = page(state.items, args, PLAYLIST_PAGE_MAX);
    return {
      playlist: {
        ...briefPlaylist(state.playlist),
        description: state.playlist.description,
        total_duration: formatTotalDuration(totalMs),
      },
      offset,
      next_offset,
      items: slice.map(briefItem),
      warnings: numberedWarnings(state.warnings),
    };
  },
  summarize: (result) => {
    const r = result as { playlist: { items: number }; items: unknown[] };
    return r.items.length === r.playlist.items ? `${r.items.length} items` : `${r.items.length} of ${r.playlist.items} items`;
  },
};

const searchTracksTool: Tool = {
  name: "search_tracks",
  description:
    `Search the Spotify catalog for tracks. Give free text and/or filters; at most ${SEARCH_MAX_LIMIT} results ` +
    `per call (use offset for more). Results include uri, album_uri, released (the edition's date), and isrc.`,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free text." },
      track: { type: "string", description: "Track title filter." },
      artist: { type: "string", description: "Artist name filter." },
      album: { type: "string", description: "Album name filter." },
      year: {
        type: "string",
        description: "Year or range (e.g. 1945 or 1945-1947). It matches the edition's release year, not the recording year.",
      },
      limit: { type: "integer", description: `1-${SEARCH_MAX_LIMIT}. Default ${SEARCH_MAX_LIMIT}.`, minimum: 1, maximum: SEARCH_MAX_LIMIT },
      offset: { type: "integer", description: "Default 0.", minimum: 0 },
    },
    additionalProperties: false,
  },
  async run(args, { client }) {
    const result = await searchTracks(
      client,
      { query: str(args, "query"), track: str(args, "track"), artist: str(args, "artist"), album: str(args, "album"), year: str(args, "year") },
      (args.limit as number | undefined) ?? SEARCH_MAX_LIMIT,
      (args.offset as number | undefined) ?? 0,
    );
    return {
      query: result.query,
      total: result.total,
      next_offset: result.next_offset,
      results: result.results.map(briefTrack),
      warnings: result.warnings,
    };
  },
  summarize: (result) => `${(result as { results: unknown[] }).results.length} results`,
};

export const SEARCH_MANY_MAX = 25;
/** Concurrent searches: modest, since the Development Mode quota is shared per developer account. */
const SEARCH_MANY_WORKERS = 4;

/** Run `fn` over `items` with at most `workers` in flight; results keep the input order. */
async function pool<T, R>(items: T[], workers: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

const searchMany: Tool = {
  name: "search_many",
  description:
    `Run up to ${SEARCH_MANY_MAX} track searches in one call (for example one per song of a list), with a few ` +
    "results each. Prefer it over repeated search_tracks calls. Each search takes track and artist (and optionally " +
    "album, year, or free text). One failed search does not fail the others.",
  parameters: {
    type: "object",
    properties: {
      searches: {
        type: "array",
        description: 'Searches, e.g. [{"track": "Salt Peanuts", "artist": "Dizzy Gillespie"}, …].',
        items: {
          type: "object",
          properties: {
            track: { type: "string", description: "Track title." },
            artist: { type: "string", description: "Artist name." },
            album: { type: "string", description: "Album name." },
            year: { type: "string", description: "Edition release year or range (not the recording year)." },
            query: { type: "string", description: "Free text." },
          },
          additionalProperties: false,
        },
        minItems: 1,
        maxItems: SEARCH_MANY_MAX,
      },
      limit_each: { type: "integer", description: "Results per search, 1-5. Default 3.", minimum: 1, maximum: 5 },
    },
    required: ["searches"],
    additionalProperties: false,
  },
  async run(args, { client }) {
    const searches = args.searches as Record<string, string>[];
    const limit = (args.limit_each as number | undefined) ?? 3;
    const results = await pool(searches, SEARCH_MANY_WORKERS, async (s, index) => {
      try {
        const r = await searchTracks(client, { query: s.query, track: s.track, artist: s.artist, album: s.album, year: s.year }, limit, 0);
        return { index, query: r.query, total: r.total, results: r.results.map(briefTrack) };
      } catch (exc) {
        // Authorization failures stop the whole call (the UI asks to log in again); others stay per search.
        if (exc instanceof SpotikitError && !["AUTH_REQUIRED", "AUTH_EXPIRED", "CONFIG_ERROR"].includes(exc.code)) {
          return { index, error: { code: exc.code, message: exc.message } };
        }
        throw exc;
      }
    });
    return { count: results.length, failed: results.filter((r) => "error" in r).length, searches: results };
  },
  summarize: (result) => {
    const r = result as { count: number; failed: number; searches: { results?: unknown[] }[] };
    const empty = r.searches.filter((s) => s.results && s.results.length === 0).length;
    return `${r.count} searches${empty ? `, ${empty} without results` : ""}${r.failed ? `, ${r.failed} failed` : ""}`;
  },
};

const trackShow: Tool = {
  name: "track_show",
  description: "Show one track: uri, name, artists, album, album_uri, released, duration, isrc.",
  parameters: {
    type: "object",
    properties: {
      track_id: {
        type: "string",
        description: "Track id, spotify:track: URI, or open.spotify.com URL, taken from a tool result or the user.",
        minLength: 1,
      },
    },
    required: ["track_id"],
    additionalProperties: false,
  },
  async run(args, { client }) {
    return { track: briefTrack((await getTrack(client, str(args, "track_id")!)).track) };
  },
  summarize: (result) => (result as { track: { name: string | null } }).track.name ?? "track",
};

const albumTracks: Tool = {
  name: "album_tracks",
  description:
    `List an album's tracks in order (uri, name, artists, duration, track and disc number). Up to ` +
    `${ALBUM_PAGE_MAX} per call; use offset=next_offset for the rest. Useful to pick the exact take inside an edition.`,
  parameters: {
    type: "object",
    properties: {
      album_id: {
        type: "string",
        description: "Album id, spotify:album: URI (album_uri in other results), or open.spotify.com URL.",
        minLength: 1,
      },
      offset: { type: "integer", description: "Default 0.", minimum: 0 },
      limit: { type: "integer", description: `1-${ALBUM_PAGE_MAX}. Default ${ALBUM_PAGE_MAX}.`, minimum: 1, maximum: ALBUM_PAGE_MAX },
    },
    required: ["album_id"],
    additionalProperties: false,
  },
  async run(args, { client }) {
    const data = await getAlbumTracks(client, str(args, "album_id")!);
    const { offset, next_offset, slice } = page(data.tracks, args, ALBUM_PAGE_MAX);
    return { album: briefAlbum(data.album), offset, next_offset, tracks: slice.map(briefAlbumTrack) };
  },
  summarize: (result) => `${(result as { tracks: unknown[] }).tracks.length} tracks`,
};

export const READ_TOOLS: Tool[] = [playlistsList, playlistShow, searchTracksTool, searchMany, trackShow, albumTracks];
