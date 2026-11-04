// The IndexedDB stores and the one-time move of their data from the database's former name, against
// fake-indexeddb (a fresh IDBFactory per test, so no test sees another's databases).

import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DB_NAME, DB_VERSION, isPersistent, LEGACY_DB_NAME, migrateLegacyDatabase, openStore, STORES } from "../src/storage/kv";

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

/** Makes the copy into the new database call `replace` for each record it writes (the old one is untouched). */
function interceptCopy(replace: (value: unknown, key: IDBValidKey | undefined, call: number) => unknown): void {
  const put = IDBObjectStore.prototype.put;
  let call = 0;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.transaction.db.name !== DB_NAME) return put.call(this, value, key);
    call += 1;
    return put.call(this, replace(value, key, call), key);
  });
}

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

    expect((await dump(factory, LEGACY_DB_NAME)).records).toEqual(unknown);
    expect((await dump(factory, DB_NAME)).records).toEqual(empty());
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

describe("openStore", () => {
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
    expect(await writeLog.keys()).toEqual(["someplaylist"]);
    expect((await dump(factory, LEGACY_DB_NAME)).records).toEqual(LEGACY);
  });
});
