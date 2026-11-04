// The IndexedDB stores and the one-time move of their data from the database's former name, against
// fake-indexeddb (a fresh IDBFactory per test, so no test sees another's databases).

import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DB_NAME,
  DB_VERSION,
  isPersistent,
  LEGACY_DB_NAME,
  mergeLegacyDatabase,
  MIGRATION_LOCK,
  migrateLegacyDatabase,
  migrationOutcome,
  openStore,
  STORES,
} from "../src/storage/kv";

type Records = Record<string, Record<string, unknown>>;

/** What a user of the app before the rename has: a write-log entry, two plan backups, recording dates. */
const LEGACY: Records = {
  "write-log": {
    "1a2B3c4D5e6F7g8H9i0JkL": { snapshot_id: "snap-2", uris: ["spotify:track:aaaa", "spotify:track:bbbb"], recorded_at: 1_793_000_000_000 },
  },
  "plan-backups": {
    "20261101T120000Z-remove-1a2B3c4D-a1b2": {
      created_at: "2026-11-01T12:00:00Z",
      plan_id: "20261101T120000Z-remove-1a2B3c4D-a1b2",
      playlist: { id: "1a2B3c4D5e6F7g8H9i0JkL", name: "Bebop test", snapshot_id: "snap-1" },
      items: [{ position: 0, uri: "spotify:track:aaaa", name: "Ko-Ko", artists: ["Charlie Parker"] }],
      checked: new Date("2026-11-01T12:00:05Z"),
    },
    "20261102T080000Z-details-1a2B3c4D-c3d4": {
      created_at: "2026-11-02T08:00:00Z",
      plan_id: "20261102T080000Z-details-1a2B3c4D-c3d4",
      playlist: { id: "1a2B3c4D5e6F7g8H9i0JkL", name: "Bebop test", description: "" },
    },
  },
  recordings: {
    recordings: {
      "spotify:track:aaaa": { recorded: "1945-11-26", confidence: "high", source: "discography", isrc: null },
      "spotify:track:bbbb": { recorded: "1947", confidence: "low", source: "liner notes", note: "master take" },
    },
  },
};

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

/** Creates a database at `version` with one store per key of `records`, and fills it. */
async function seed(factory: IDBFactory, name: string, version: number, records: Records): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(name, version);
    open.onupgradeneeded = () => {
      for (const store of Object.keys(records)) open.result.createObjectStore(store);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const tx = db.transaction(Object.keys(records), "readwrite");
  for (const [store, entries] of Object.entries(records)) {
    for (const [key, value] of Object.entries(entries)) tx.objectStore(store).put(value, key);
  }
  await committed(tx);
  db.close();
}

/** Every record of an existing database, by store, and its version. */
async function dump(factory: IDBFactory, name: string): Promise<{ version: number; records: Records }> {
  const db = await req(factory.open(name));
  const records: Records = {};
  const names = Array.from(db.objectStoreNames);
  if (names.length) {
    const tx = db.transaction(names, "readonly");
    for (const store of names) {
      const keys = await req(tx.objectStore(store).getAllKeys());
      const values = await req(tx.objectStore(store).getAll());
      records[store] = Object.fromEntries(keys.map((key, i) => [String(key), values[i]]));
    }
  }
  db.close();
  return { version: db.version, records };
}

async function databaseNames(factory: IDBFactory): Promise<string[]> {
  return (await IDBFactory.prototype.databases.call(factory)).map((db) => db.name ?? "").sort();
}

const empty = (): Records => Object.fromEntries(STORES.map((store) => [store, {}]));

/** Makes the copy into the new database call `replace` for each record it adds (the old one is untouched). */
function interceptCopy(replace: (value: unknown, key: IDBValidKey | undefined, call: number) => unknown): void {
  const add = IDBObjectStore.prototype.add;
  let call = 0;
  vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.transaction.db.name !== DB_NAME) return add.call(this, value, key);
    call += 1;
    return add.call(this, replace(value, key, call), key);
  });
}

/** A Web Locks stand-in that runs callbacks one at a time, in order, and records the lock names. */
class FakeLocks {
  readonly names: string[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  request<T>(name: string, callback: () => Promise<T>): Promise<T> {
    this.names.push(name);
    const run = this.tail.then(() => callback());
    this.tail = run.catch(() => {});
    return run;
  }
}

const asLocks = (locks: object) => locks as unknown as Pick<LockManager, "request">;

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}

/** Newer data the app saved in the new database after a move that didn't happen: a different value under
 * the recordings key, and a write-log entry of its own. */
const NEWER: Records = {
  ...empty(),
  "write-log": { "9z8Y7x6W5v4U3t2S1r0QpO": { snapshot_id: "snap-new", uris: [], recorded_at: 1_793_100_000_000 } },
  recordings: { recordings: { "spotify:track:cccc": { recorded: "1951-05-01", confidence: "high", source: "discography" } } },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("migrateLegacyDatabase", () => {
  it("copies every store and record into the new database, then deletes the old one", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);

    expect(await migrateLegacyDatabase(factory)).toBe("migrated");

    expect(await databaseNames(factory)).toEqual([DB_NAME]);
    const moved = await dump(factory, DB_NAME);
    expect(moved.version).toBe(DB_VERSION);
    expect(Object.keys(moved.records).sort()).toEqual([...STORES].sort());
    expect(moved.records).toEqual(LEGACY);
  });

  it("moves a database from before the recordings store (version 1) and creates the missing store", async () => {
    const factory = new IDBFactory();
    const v1 = { "write-log": LEGACY["write-log"]!, "plan-backups": LEGACY["plan-backups"]! };
    await seed(factory, LEGACY_DB_NAME, 1, v1);

    expect(await migrateLegacyDatabase(factory)).toBe("migrated");

    expect(await databaseNames(factory)).toEqual([DB_NAME]);
    expect((await dump(factory, DB_NAME)).records).toEqual({ ...v1, recordings: {} });
  });

  it("does nothing, and creates nothing, without an old database", async () => {
    const factory = new IDBFactory();

    expect(await migrateLegacyDatabase(factory)).toBe("no-legacy");

    expect(await databaseNames(factory)).toEqual([]);
  });

  it("moves the data once when it runs twice", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);

    expect(await migrateLegacyDatabase(factory)).toBe("migrated");
    expect(await migrateLegacyDatabase(factory)).toBe("no-legacy");

    expect(await databaseNames(factory)).toEqual([DB_NAME]);
    expect((await dump(factory, DB_NAME)).records).toEqual(LEGACY);
  });

  it("leaves both databases alone when the new one already holds data", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);
    const newer = { ...empty(), recordings: { recordings: { "spotify:track:cccc": { recorded: "1951", confidence: "medium", source: "x" } } } };
    await seed(factory, DB_NAME, DB_VERSION, newer);

    expect(await migrateLegacyDatabase(factory)).toBe("skipped");

    expect((await dump(factory, LEGACY_DB_NAME)).records).toEqual(LEGACY);
    expect((await dump(factory, DB_NAME)).records).toEqual(newer);
  });

  it("keeps the old database intact and the new one empty when the copy fails halfway, and retries next time", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);
    interceptCopy((value, _key, call) => {
      if (call === 3) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return value;
    });

    expect(await migrateLegacyDatabase(factory)).toBe("failed");

    expect(await databaseNames(factory)).toEqual([DB_NAME, LEGACY_DB_NAME].sort());
    expect(await dump(factory, LEGACY_DB_NAME)).toEqual({ version: 2, records: LEGACY });
    expect((await dump(factory, DB_NAME)).records).toEqual(empty());

    vi.restoreAllMocks();
    expect(await migrateLegacyDatabase(factory)).toBe("migrated");
    expect(await databaseNames(factory)).toEqual([DB_NAME]);
    expect((await dump(factory, DB_NAME)).records).toEqual(LEGACY);
  });

  it("discards a copy that differs from the original and keeps the old database", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);
    interceptCopy((value, key) => (key === "recordings" ? { ...(value as object), "spotify:track:zzzz": {} } : value));

    expect(await migrateLegacyDatabase(factory)).toBe("failed");

    expect((await dump(factory, LEGACY_DB_NAME)).records).toEqual(LEGACY);
    expect((await dump(factory, DB_NAME)).records).toEqual(empty());
  });

  it("keeps the old database when it has a store this version doesn't know", async () => {
    const factory = new IDBFactory();
    const unknown = { ...LEGACY, "something-else": { key: "value" } };
    await seed(factory, LEGACY_DB_NAME, 3, unknown);

    expect(await migrateLegacyDatabase(factory)).toBe("failed");

    expect(await databaseNames(factory)).toEqual([LEGACY_DB_NAME]);
    expect((await dump(factory, LEGACY_DB_NAME)).records).toEqual(unknown);
  });

  it("works where indexedDB.databases() is missing (older browsers)", async () => {
    const without = () => {
      const factory = new IDBFactory();
      Object.defineProperty(factory, "databases", { value: undefined });
      return factory;
    };

    const fresh = without();
    expect(await migrateLegacyDatabase(fresh)).toBe("no-legacy");
    expect(await databaseNames(fresh)).toEqual([]);

    const old = without();
    await seed(old, LEGACY_DB_NAME, 2, LEGACY);
    expect(await migrateLegacyDatabase(old)).toBe("migrated");
    expect(await databaseNames(old)).toEqual([DB_NAME]);
    expect((await dump(old, DB_NAME)).records).toEqual(LEGACY);
  });
});

describe("the old database held open, or already empty", () => {
  it("reports delete-blocked while another tab holds the old database open, and it goes once that tab closes", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);
    // An open connection that, unlike the app, doesn't close when asked to.
    const otherTab = await req(factory.open(LEGACY_DB_NAME));

    expect(await migrateLegacyDatabase(factory)).toBe("delete-blocked");

    expect((await dump(factory, DB_NAME)).records).toEqual(LEGACY);
    expect(await databaseNames(factory)).toEqual([DB_NAME, LEGACY_DB_NAME].sort());
    otherTab.close();
    await until(async () => !(await databaseNames(factory)).includes(LEGACY_DB_NAME));
    expect((await dump(factory, DB_NAME)).records).toEqual(LEGACY);
  });

  it("doesn't hang, or hold the lock, behind a deletion another tab blocks: a second run reports busy", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);
    const otherTab = await req(factory.open(LEGACY_DB_NAME));
    const locks = new FakeLocks();

    const outcomes = await Promise.all([migrateLegacyDatabase(factory, asLocks(locks)), migrateLegacyDatabase(factory, asLocks(locks))]);

    expect(outcomes).toEqual(["delete-blocked", "busy"]);
    expect((await mergeLegacyDatabase(factory, asLocks(locks))).outcome).toBe("busy");
    expect((await dump(factory, DB_NAME)).records).toEqual(LEGACY);
    otherTab.close();
    await until(async () => !(await databaseNames(factory)).includes(LEGACY_DB_NAME));
    expect(await migrateLegacyDatabase(factory, asLocks(locks))).toBe("no-legacy");
  });

  it("reports busy, moving nothing, when the old database is slow to open, and moves it once it opens", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);
    // Another tab holds the old database open while a third asks to upgrade it: every open waits behind that.
    const otherTab = await req(factory.open(LEGACY_DB_NAME));
    const upgrade = factory.open(LEGACY_DB_NAME, 3);
    const locks = new FakeLocks();

    expect(await migrateLegacyDatabase(factory, asLocks(locks))).toBe("busy");

    expect(await databaseNames(factory)).toEqual([LEGACY_DB_NAME]);
    otherTab.close();
    (await req(upgrade)).close();
    expect(await migrateLegacyDatabase(factory, asLocks(locks))).toBe("migrated");
    expect((await dump(factory, DB_NAME)).records).toEqual(LEGACY);
  });

  it("reports busy, and releases the lock, when another tab's older connection holds up the new database", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);
    // A tab of a version that knew the new database at version 1, and doesn't close when asked to.
    const olderTab = await req(factory.open(DB_NAME, 1));
    const locks = new FakeLocks();

    expect(await migrateLegacyDatabase(factory, asLocks(locks))).toBe("busy");

    expect((await dump(factory, LEGACY_DB_NAME)).records).toEqual(LEGACY);
    olderTab.close();
    expect(await migrateLegacyDatabase(factory, asLocks(locks))).toBe("migrated");
    expect((await dump(factory, DB_NAME)).records).toEqual(LEGACY);
  });

  it("deletes an old database whose records are all in the new one already (an earlier deletion that was blocked)", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);
    await seed(factory, DB_NAME, DB_VERSION, LEGACY);

    expect(await migrateLegacyDatabase(factory)).toBe("migrated");

    expect(await databaseNames(factory)).toEqual([DB_NAME]);
    expect((await dump(factory, DB_NAME)).records).toEqual(LEGACY);
  });

  it("deletes an empty old database (an old tab recreates it after the move) without counting it as data left behind", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, empty());
    await seed(factory, DB_NAME, DB_VERSION, NEWER);

    expect(await migrateLegacyDatabase(factory)).toBe("no-legacy");

    expect(await databaseNames(factory)).toEqual([DB_NAME]);
    expect((await dump(factory, DB_NAME)).records).toEqual(NEWER);
  });
});

describe("mergeLegacyDatabase (the retry)", () => {
  it("adds the missing records, replaces none, and keeps the old database while some of it differs", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);
    await seed(factory, DB_NAME, DB_VERSION, NEWER);
    expect(await migrateLegacyDatabase(factory)).toBe("skipped");

    expect(await mergeLegacyDatabase(factory, null)).toEqual({ outcome: "skipped", moved: 3, kept: 1 });

    expect((await dump(factory, DB_NAME)).records).toEqual({
      "write-log": { ...LEGACY["write-log"], ...NEWER["write-log"] },
      "plan-backups": LEGACY["plan-backups"],
      recordings: NEWER.recordings,
    });
    expect((await dump(factory, LEGACY_DB_NAME)).records).toEqual(LEGACY);
  });

  it("finishes the move, and deletes the old database, when nothing differs", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);
    const unrelated = { ...empty(), "write-log": NEWER["write-log"]! };
    await seed(factory, DB_NAME, DB_VERSION, unrelated);
    expect(await migrateLegacyDatabase(factory)).toBe("skipped");

    expect(await mergeLegacyDatabase(factory, null)).toEqual({ outcome: "migrated", moved: 4, kept: 0 });

    expect(await databaseNames(factory)).toEqual([DB_NAME]);
    expect((await dump(factory, DB_NAME)).records).toEqual({ ...LEGACY, "write-log": { ...LEGACY["write-log"], ...NEWER["write-log"] } });
  });

  it("leaves the newer data exactly as it was when the retry fails halfway", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);
    await seed(factory, DB_NAME, DB_VERSION, NEWER);
    interceptCopy((value, _key, call) => {
      if (call === 2) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return value;
    });

    expect((await mergeLegacyDatabase(factory, null)).outcome).toBe("failed");

    expect((await dump(factory, DB_NAME)).records).toEqual(NEWER);
    expect((await dump(factory, LEGACY_DB_NAME)).records).toEqual(LEGACY);
  });

  it("takes back only what it added when its copy differs, never the newer data", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);
    await seed(factory, DB_NAME, DB_VERSION, NEWER);
    interceptCopy((value, key) => (typeof key === "string" && key.includes("details") ? { tampered: true } : value));

    expect((await mergeLegacyDatabase(factory, null)).outcome).toBe("failed");

    expect((await dump(factory, DB_NAME)).records).toEqual(NEWER);
    expect((await dump(factory, LEGACY_DB_NAME)).records).toEqual(LEGACY);
  });

  it("does nothing without an old database", async () => {
    const factory = new IDBFactory();

    expect(await mergeLegacyDatabase(factory, null)).toEqual({ outcome: "no-legacy", moved: 0, kept: 0 });
    expect(await databaseNames(factory)).toEqual([]);
  });
});

describe("two tabs at once", () => {
  it("moves the data once: the second tab, waiting for the lock, finds the work done", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);
    const locks = new FakeLocks();

    const outcomes = await Promise.all([migrateLegacyDatabase(factory, asLocks(locks)), migrateLegacyDatabase(factory, asLocks(locks))]);

    expect(outcomes.sort()).toEqual(["migrated", "no-legacy"]);
    expect(locks.names).toEqual([MIGRATION_LOCK, MIGRATION_LOCK]);
    expect(MIGRATION_LOCK).toBe("curatune-web-migrate");
    expect(await databaseNames(factory)).toEqual([DB_NAME]);
    expect((await dump(factory, DB_NAME)).records).toEqual(LEGACY);
  });

  it("moves the data without the Web Locks API, and when taking the lock fails", async () => {
    const withoutLocks = new IDBFactory();
    await seed(withoutLocks, LEGACY_DB_NAME, 2, LEGACY);
    expect(await migrateLegacyDatabase(withoutLocks, null)).toBe("migrated");
    expect((await dump(withoutLocks, DB_NAME)).records).toEqual(LEGACY);

    const brokenLocks = new IDBFactory();
    await seed(brokenLocks, LEGACY_DB_NAME, 2, LEGACY);
    const failing = { request: () => Promise.reject(new DOMException("Locks are unavailable.", "SecurityError")) };
    expect(await migrateLegacyDatabase(brokenLocks, asLocks(failing))).toBe("migrated");
    expect((await dump(brokenLocks, DB_NAME)).records).toEqual(LEGACY);
  });
});

describe("openStore", () => {
  it("keeps what the move did for the app to report", async () => {
    const moved = new IDBFactory();
    await seed(moved, LEGACY_DB_NAME, 2, LEGACY);
    expect(migrationOutcome(moved)).toBeUndefined();
    await openStore("recordings", moved);
    expect(migrationOutcome(moved)).toBe("migrated");

    const fresh = new IDBFactory();
    await openStore("recordings", fresh);
    expect(migrationOutcome(fresh)).toBe("no-legacy");

    const conflicting = new IDBFactory();
    await seed(conflicting, LEGACY_DB_NAME, 2, LEGACY);
    await seed(conflicting, DB_NAME, DB_VERSION, NEWER);
    await openStore("recordings", conflicting);
    expect(migrationOutcome(conflicting)).toBe("skipped");
  });

  it("serves the moved data from the new database", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);

    const recordings = await openStore("recordings", factory);
    const backups = await openStore("plan-backups", factory);

    expect(isPersistent(recordings)).toBe(true);
    expect(await recordings.get("recordings")).toEqual(LEGACY.recordings!.recordings);
    expect((await backups.keys()).sort()).toEqual(Object.keys(LEGACY["plan-backups"]!).sort());
    expect(await databaseNames(factory)).toEqual([DB_NAME]);
  });

  it("keeps working with the new database when the migration fails, and leaves the old one intact", async () => {
    const factory = new IDBFactory();
    await seed(factory, LEGACY_DB_NAME, 2, LEGACY);
    interceptCopy((value, _key, call) => {
      if (call === 1) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return value;
    });

    const writeLog = await openStore("write-log", factory);
    await writeLog.set("someplaylist", { snapshot_id: "snap-9", uris: [], recorded_at: 1 });

    expect(isPersistent(writeLog)).toBe(true);
    expect(migrationOutcome(factory)).toBe("failed");
    expect(await writeLog.keys()).toEqual(["someplaylist"]);
    expect((await dump(factory, LEGACY_DB_NAME)).records).toEqual(LEGACY);
  });
});
