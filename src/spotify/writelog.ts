// Local record of this app's own writes, used to compensate Spotify's snapshot_id read lag.
// Follows curatune commit 590cd87, src/spotikit/writelog.py. Difference: stored in IndexedDB through an
// async KeyValueStore instead of a JSON file. The web app and the curatune CLI keep separate logs, so do
// not write the same playlist from both within minutes.
//
// After a write, GET /playlists/{id} keeps returning the previous snapshot_id for a few minutes, while
// the item list is already current. The snapshot returned by the write itself is the one reads eventually
// converge to. Recording it (with the item URIs expected after the write) lets us recognize a lagging read:
// same items as recorded, different snapshot, recent write.

import type { KeyValueStore } from "../storage/kv";

/** Lag observed live was a few minutes; entries older than this are ignored. */
export const ENTRY_TTL_MS = 15 * 60_000;

interface Entry {
  snapshot_id: string;
  uris: (string | null)[];
  recorded_at: number;
}

export class WriteLog {
  constructor(
    private readonly store: KeyValueStore,
    private readonly ttlMs = ENTRY_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async record(playlistId: string, snapshotId: string, uris: (string | null)[]): Promise<void> {
    const entry: Entry = { snapshot_id: snapshotId, uris, recorded_at: this.now() };
    await this.store.set(playlistId, entry);
  }

  async forget(playlistId: string): Promise<void> {
    await this.store.delete(playlistId);
  }

  /**
   * Item counts expected after this app's recent writes, by playlist id. The playlist list lags behind
   * writes too (`GET /me/playlists` keeps the old `items.total` for a while), so listing prefers these while
   * they differ. Entries are not dropped here; only a full read (`resolve`) can tell whether a playlist
   * moved on.
   */
  async expectedCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const playlistId of await this.store.keys()) {
      const entry = await this.store.get<Entry>(playlistId);
      if (entry && this.now() - entry.recorded_at <= this.ttlMs) counts.set(playlistId, entry.uris.length);
    }
    return counts;
  }

  /**
   * Return the effective snapshot_id and whether the read is lagging. The read is considered lagging only
   * if we wrote to this playlist recently, the items read match exactly what we expect after that write,
   * and the snapshot read differs from the one the write returned. Once reads converge, the entry is dropped.
   */
  async resolve(playlistId: string, readSnapshot: string, readUris: (string | null)[]): Promise<[string, boolean]> {
    const entry = await this.store.get<Entry>(playlistId);
    if (!entry) return [readSnapshot, false];
    if (entry.snapshot_id === readSnapshot || this.now() - entry.recorded_at > this.ttlMs) {
      await this.forget(playlistId);
      return [readSnapshot, false];
    }
    if (entry.uris.length === readUris.length && entry.uris.every((uri, i) => uri === readUris[i])) {
      return [entry.snapshot_id, true];
    }
    // Items diverged from what we wrote: the playlist moved on; the entry no longer applies.
    await this.forget(playlistId);
    return [readSnapshot, false];
  }
}
