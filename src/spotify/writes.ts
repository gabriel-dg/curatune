// Writes allowed without a plan: create a playlist, add items.
// Follows curatune commit b3531aa, src/spotikit/playlists.py (create_playlist, add_items) and
// src/spotikit/_writes.py (insert_uris). Differences, all deliberate:
// - create always requests a private playlist: the caller (the model) never chooses visibility.
// - add re-reads the playlist after writing and reports whether the new items are where expected.
// - Both record to the write log (when the client has one), so plans built right after still apply.
// There is deliberately no function to remove, reorder, rename, or change visibility here.

import { CuratuneError } from "./errors";
import type { SpotifyClient } from "./http";
import { normalizePlaylist, type Playlist, type PlaylistItem } from "./models";
import { getPlaylist, listPlaylists, type Warning } from "./playlists";
import { normalizeItemUri } from "./refs";

export const MAX_URIS_PER_REQUEST = 100;

export interface CreateResult {
  playlist: Playlist;
  visibility: { requested_public: boolean; reported_public: boolean | null };
  warnings: Warning[];
}

export interface AddResult {
  playlist: Playlist;
  added: { position: number; uri: string }[];
  skipped: { uri: string; reason: "already_in_playlist" | "duplicate_in_input" }[];
  item_count: number;
  /** The playlist re-read after the write; null when nothing was added. */
  items_after: PlaylistItem[] | null;
  /** True when the re-read shows every added URI at its expected position. */
  verified: boolean;
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export function requireEditable(playlist: Playlist): void {
  if (!(playlist.owned || playlist.collaborative)) {
    throw new CuratuneError("FORBIDDEN", "You can only modify playlists you own or collaborate on.", {
      playlist_id: playlist.id,
      owner_id: playlist.owner_id,
    });
  }
}

export async function createPlaylist(
  client: SpotifyClient,
  rawName: string,
  description = "",
  allowDuplicateName = false,
): Promise<CreateResult> {
  const name = (rawName ?? "").trim();
  if (!name) throw new CuratuneError("INVALID_ARGUMENT", "Playlist name cannot be empty.");
  if (!allowDuplicateName) {
    const existing = (await listPlaylists(client, true)).playlists.filter(
      (p) => (p.name ?? "").trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (existing.length) {
      throw new CuratuneError("DUPLICATE_NAME", "You already own a playlist with this name.", {
        existing: existing.map((p) => ({ id: p.id, name: p.name })),
      });
    }
  }
  const requestedPublic = false;
  const body: Record<string, unknown> = { name, public: requestedPublic };
  if (description.trim()) body.description = description.trim();
  const created = await client.post<Record<string, unknown>>("/me/playlists", body);
  const playlist = normalizePlaylist(created, await client.currentUserId());
  if (client.writeLog && playlist.id && playlist.snapshot_id) await client.writeLog.record(playlist.id, playlist.snapshot_id, []);

  // The create response echoes the requested visibility even when Spotify ignores it (public=false is
  // not applied: known issue, confirmed live by curatune 2026-09-23). Report what a read says instead,
  // and never claim the playlist is private.
  const read = await client.get<{ public?: boolean | null }>(`/playlists/${playlist.id}`, { fields: "public" });
  const reportedPublic = read.public ?? null;
  playlist.public = reportedPublic;
  playlist.item_count = 0;
  const warnings: Warning[] = [];
  if (reportedPublic === false) {
    warnings.push({
      code: "VISIBILITY_UNVERIFIED",
      message: "Spotify reports the playlist as private, but it is known to ignore private on creation; check it in the Spotify app.",
      reported_public: reportedPublic,
    });
  } else {
    warnings.push({
      code: "VISIBILITY_NOT_APPLIED",
      message: "Spotify ignored the private setting: the playlist is public. It can be made private in the Spotify app (the API does not apply it either).",
      reported_public: reportedPublic,
    });
  }
  return { playlist, visibility: { requested_public: requestedPublic, reported_public: reportedPublic }, warnings };
}

/**
 * Add items at `position` (0-based; default: append). URIs already in the playlist, or repeated in the
 * input, are skipped unless `allowDuplicates`.
 */
export async function addItems(
  client: SpotifyClient,
  ref: string,
  itemRefs: string[],
  position: number | null = null,
  allowDuplicates = false,
): Promise<AddResult> {
  const uris = itemRefs.map(normalizeItemUri);
  if (!uris.length) throw new CuratuneError("INVALID_ARGUMENT", "No items to add.");

  const state = await getPlaylist(client, ref);
  const playlist = state.playlist;
  requireEditable(playlist);
  const count = state.items.length;
  if (position !== null && !(Number.isInteger(position) && position >= 0 && position <= count)) {
    throw new CuratuneError("INVALID_ARGUMENT", "Position is out of range.", { position, item_count: count });
  }

  const present = new Set(state.items.map((i) => i.uri));
  const toAdd: string[] = [];
  const skipped: AddResult["skipped"] = [];
  for (const uri of uris) {
    if (!allowDuplicates && present.has(uri)) skipped.push({ uri, reason: "already_in_playlist" });
    else if (!allowDuplicates && toAdd.includes(uri)) skipped.push({ uri, reason: "duplicate_in_input" });
    else toAdd.push(uri);
  }

  let insertAt = position;
  let snapshotId = playlist.snapshot_id;
  for (const chunk of chunks(toAdd, MAX_URIS_PER_REQUEST)) {
    const body: Record<string, unknown> = { uris: chunk };
    if (insertAt !== null) body.position = insertAt;
    snapshotId = (await client.post<{ snapshot_id?: string }>(`/playlists/${playlist.id}/items`, body))?.snapshot_id ?? snapshotId;
    if (insertAt !== null) insertAt += chunk.length;
  }

  const start = position ?? count;
  const added = toAdd.map((uri, i) => ({ position: start + i, uri }));
  if (toAdd.length && client.writeLog && snapshotId) {
    const expected: (string | null)[] = state.items.map((i) => i.uri);
    expected.splice(start, 0, ...toAdd);
    await client.writeLog.record(playlist.id!, snapshotId, expected);
  }
  let itemsAfter: PlaylistItem[] | null = null;
  let verified = true;
  if (toAdd.length) {
    // The write already happened: a failed re-read must not turn it into a reported failure (the caller
    // could retry and add the tracks twice), so it only leaves the result unverified.
    try {
      const after = await getPlaylist(client, playlist.id!);
      itemsAfter = after.items;
      verified = after.items.length === count + toAdd.length && added.every((a) => after.items[a.position]?.uri === a.uri);
    } catch (exc) {
      if (exc instanceof CuratuneError && (exc.code === "AUTH_REQUIRED" || exc.code === "AUTH_EXPIRED")) throw exc;
      verified = false;
    }
  }
  return {
    playlist,
    added,
    skipped,
    item_count: itemsAfter?.length ?? count,
    items_after: itemsAfter,
    verified,
  };
}
