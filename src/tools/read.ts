// Read-only tools (phase 2): schemas for the model and handlers over src/spotify. No tool writes to
// Spotify; there is deliberately no tool that applies a plan (see AGENTS.md).

import { getAlbumTracks, getTrack, SEARCH_MAX_LIMIT, searchTracks } from "../spotify/catalog";
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
    return { count: data.count, playlists: data.playlists.map(briefPlaylist) };
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

export const READ_TOOLS: Tool[] = [playlistsList, playlistShow, searchTracksTool, trackShow, albumTracks];
