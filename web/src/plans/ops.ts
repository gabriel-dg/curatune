// Low-level mutating calls: remove URIs, move a range, change name/description.
// Follows curatune commit b3531aa, src/spotikit/_writes.py. Only src/plans/ may import this module
// (tests/invariants.test.ts checks it): removals, reorders, and renames happen only by applying a plan
// that was validated against the live playlist first, and only from the UI's Apply button.

import type { SpotifyClient } from "../spotify/http";

export const DETAIL_FIELDS = ["name", "description"] as const;
export type DetailField = (typeof DETAIL_FIELDS)[number];

export async function insertUris(client: SpotifyClient, playlistId: string, uris: string[], position: number): Promise<string> {
  return (await client.post<{ snapshot_id: string }>(`/playlists/${playlistId}/items`, { uris, position })).snapshot_id;
}

/** The API takes URIs only (no positions): every occurrence of each URI is removed. */
export async function removeUris(client: SpotifyClient, playlistId: string, uris: string[], snapshotId: string): Promise<string> {
  const body = { items: uris.map((uri) => ({ uri })), snapshot_id: snapshotId };
  return (await client.delete<{ snapshot_id: string }>(`/playlists/${playlistId}/items`, body)).snapshot_id;
}

export async function moveRange(
  client: SpotifyClient,
  playlistId: string,
  rangeStart: number,
  insertBefore: number,
  rangeLength: number,
  snapshotId: string,
): Promise<string> {
  const body = { range_start: rangeStart, insert_before: insertBefore, range_length: rangeLength, snapshot_id: snapshotId };
  return (await client.put<{ snapshot_id: string }>(`/playlists/${playlistId}/items`, body)).snapshot_id;
}

/** Only name and description, ever: visibility and collaboration are deliberately out of reach. */
export async function setDetails(client: SpotifyClient, playlistId: string, fields: Partial<Record<DetailField, string>>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length || keys.some((k) => !(DETAIL_FIELDS as readonly string[]).includes(k))) {
    throw new Error(`setDetails only accepts ${DETAIL_FIELDS.join(", ")}, got ${keys.join(", ")}`);
  }
  // 200 with an empty body; returns no snapshot_id.
  await client.put(`/playlists/${playlistId}`, { ...fields });
}
