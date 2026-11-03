// Copies of Spotify metadata are not kept indefinitely (Developer Terms IV.3): old plan backups and expired
// write-log entries are deleted (curatune commit 60aff60, retention.py and writelog.py).

import { describe, expect, it } from "vitest";
import { BACKUP_RETENTION_DAYS, pruneBackups } from "../src/plans/plans";
import { WriteLog } from "../src/spotify/writelog";
import { MemoryStore } from "../src/storage/kv";

const DAY = 86_400_000;

describe("pruneBackups", () => {
  it("deletes backups older than the retention period and keeps the rest", async () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    const backups = new MemoryStore();
    await backups.set("old", { created_at: new Date(now - (BACKUP_RETENTION_DAYS + 1) * DAY).toISOString() });
    await backups.set("recent", { created_at: new Date(now - 10 * DAY).toISOString() });
    await backups.set("undated", { note: "not a backup this app wrote" });
    expect(await pruneBackups(backups, now)).toBe(1);
    expect((await backups.keys()).sort()).toEqual(["recent", "undated"]);
  });
});

describe("WriteLog.prune", () => {
  it("drops expired entries, and every write does it too", async () => {
    let now = 0;
    const store = new MemoryStore();
    const log = new WriteLog(store, 1000, () => now);
    await log.record("old", "snap-1", ["spotify:track:a"]);
    now = 5000;
    await log.record("new", "snap-2", ["spotify:track:b"]);
    expect(await store.keys()).toEqual(["new"]);
    now = 10_000;
    await log.prune();
    expect(await store.keys()).toEqual([]);
  });
});
