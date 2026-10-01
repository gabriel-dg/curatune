// Playlist reads: list the user's playlists, read one playlist with all its items, read metadata only.
// Follows curatune commit 590cd87, src/spotikit/playlists.py (list_playlists, get_playlist,
// get_playlist_meta). Not ported: market-dependent reads (plans always read without a market). Difference:
// the metadata fields include `images` (the cover, shown in the UI).

import { CuratuneError } from "./errors";
import type { SpotifyClient } from "./http";
import { normalizePlaylist, normalizePlaylistItem, type Playlist, type PlaylistItem } from "./models";
import { parseId } from "./refs";

export const ITEMS_PAGE_LIMIT = 50;
export const PLAYLIST_META_FIELDS =
  "id,uri,name,description,owner(id,display_name),collaborative,public,snapshot_id,external_urls,images";
const READ_ATTEMPTS = 3;

export interface Warning {
  code: string;
  message: string;
  [key: string]: unknown;
}

export interface PlaylistList {
  user_id: string;
  count: number;
  playlists: Playlist[];
  warnings: Warning[];
}

export interface PlaylistState {
  playlist: Playlist;
  items: PlaylistItem[];
  warnings: Warning[];
}

type Json = Record<string, unknown>;

export async function listPlaylists(client: SpotifyClient, ownedOnly = false): Promise<PlaylistList> {
  const me = await client.currentUserId();
  let playlists: Playlist[] = [];
  for await (const p of client.paginate<Json | null>("/me/playlists", { limit: 50 })) {
    if (p) playlists.push(normalizePlaylist(p, me));
  }
  if (ownedOnly) playlists = playlists.filter((p) => p.owned);
  const warnings: Warning[] = [];
  // The list lags behind writes (its items.total stays at the old value for a while): after this app's
  // own recent writes, report the count the write left instead.
  if (client.writeLog) {
    const expected = await client.writeLog.expectedCounts();
    const corrected: { playlist_id: string; listed_item_count: number | null; item_count: number }[] = [];
    for (const p of playlists) {
      const count = p.id ? expected.get(p.id) : undefined;
      if (count !== undefined && count !== p.item_count) {
        corrected.push({ playlist_id: p.id!, listed_item_count: p.item_count, item_count: count });
        p.item_count = count;
      }
    }
    if (corrected.length) {
      warnings.push({
        code: "ITEM_COUNT_READ_LAG",
        message: "Spotify's playlist list returned stale item counts; using the counts left by this app's recent writes. Reading a playlist counts its items.",
        playlists: corrected,
      });
    }
  }
  return { user_id: me, count: playlists.length, playlists, warnings };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

/**
 * Read playlist metadata and all items as one consistent snapshot, without a market (so URIs are exactly
 * the stored ones, as plans require). Metadata and items come from separate requests, so the snapshot_id
 * is re-read at the end and the whole read is retried if the playlist changed in between.
 */
export async function getPlaylist(client: SpotifyClient, ref: string): Promise<PlaylistState> {
  const playlistId = parseId(ref, "playlist");
  const me = await client.currentUserId();
  let meta: Json | null = null;
  let entries: Json[] = [];
  for (let attempt = 0; attempt < READ_ATTEMPTS && meta === null; attempt++) {
    const read = await client.get<Json>(`/playlists/${playlistId}`, { fields: PLAYLIST_META_FIELDS });
    try {
      entries = await collect(
        client.paginate<Json>(`/playlists/${playlistId}/items`, {
          limit: ITEMS_PAGE_LIMIT,
          additional_types: "track,episode",
        }),
      );
    } catch (exc) {
      if (exc instanceof CuratuneError && exc.code === "FORBIDDEN") {
        throw new CuratuneError(
          "FORBIDDEN",
          "Playlist items are only available for playlists you own or collaborate on.",
          { ...exc.details, playlist_id: playlistId },
        );
      }
      throw exc;
    }
    const check = await client.get<Json>(`/playlists/${playlistId}`, { fields: "snapshot_id" });
    if (check.snapshot_id === read.snapshot_id) meta = read;
  }
  if (meta === null) {
    throw new CuratuneError("CONCURRENT_MODIFICATION", "The playlist kept changing while it was being read.", {
      playlist_id: playlistId,
    });
  }

  const items = entries.map((entry, i) => normalizePlaylistItem(entry, i));
  const playlist = normalizePlaylist(meta, me);
  playlist.item_count = items.length;

  const warnings: Warning[] = [];
  // Compensate snapshot_id read lag after our own writes. Reads here never use a market, so their URIs
  // are exactly the stored ones and can be compared with what the write log expects.
  if (client.writeLog && playlist.snapshot_id) {
    const readSnapshot = playlist.snapshot_id;
    const [effective, lagging] = await client.writeLog.resolve(playlistId, readSnapshot, items.map((i) => i.uri));
    if (lagging) {
      playlist.snapshot_id = effective;
      warnings.push({
        code: "SNAPSHOT_READ_LAG",
        message: "Spotify returned a stale snapshot_id; using the one returned by this app's last write to this playlist (items match exactly).",
        read_snapshot_id: readSnapshot,
        effective_snapshot_id: effective,
      });
    }
  }
  const local = items.filter((i) => i.is_local).map((i) => i.position);
  if (local.length) warnings.push({ code: "LOCAL_FILES", message: "Playlist contains local files.", positions: local });
  const unavailable = items.filter((i) => i.uri === null).map((i) => i.position);
  if (unavailable.length) {
    warnings.push({ code: "UNAVAILABLE_ITEMS", message: "Some items have no track object.", positions: unavailable });
  }
  return { playlist, items, warnings };
}

/** Playlist metadata only (no items): one request. */
export async function getPlaylistMeta(client: SpotifyClient, ref: string): Promise<Playlist> {
  const playlistId = parseId(ref, "playlist");
  const meta = await client.get<Json>(`/playlists/${playlistId}`, { fields: `${PLAYLIST_META_FIELDS},items(total)` });
  return normalizePlaylist(meta, await client.currentUserId());
}
