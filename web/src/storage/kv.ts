// Small async key-value stores for data that must survive a reload: the write log, plan backups, and
// recording dates. Never used for tokens (those stay in sessionStorage, see src/spotify/auth.ts);
// tests/invariants.test.ts only allows IndexedDB in this directory.

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** In-memory store for tests, and the fallback when IndexedDB is unavailable (private windows). */
export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.data.keys()];
  }
}

export const DB_NAME = "curatune-web";
// Bump the version whenever a store is added: onupgradeneeded creates the missing ones.
export const DB_VERSION = 2;
export const STORES = ["write-log", "plan-backups", "recordings"] as const;
export type StoreName = (typeof STORES)[number];
/** The database's name before the app was renamed. Its data moves to DB_NAME once (migrateLegacyDatabase). */
export const LEGACY_DB_NAME = "spotikit-web";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolves when the transaction commits; rejects when it aborts (a failed request aborts it too). */
function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException("The transaction was aborted.", "AbortError"));
  });
}

/** Opens the app's database at the current version, creating it or its missing stores. */
function openDatabase(factory: IDBFactory, onVersionChange?: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab opening a newer version must not wait for this one: close, and reopen on next use.
      db.onversionchange = () => {
        db.close();
        onVersionChange?.();
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * How long the move waits for a database to open. An open waits behind anything another tab holds up: a
 * deletion of the old database, or an upgrade of the new one. Past this, the move gives up for now ("busy"),
 * so that it never holds the lock for long.
 */
const OPEN_WAIT_MS = 1000;

/**
 * Opens a database at whatever version it has, only if it exists: never creates one. "waiting" when the open
 * doesn't complete within `waitMs` (see OPEN_WAIT_MS); a late open is closed at once.
 */
async function openIfExists(factory: IDBFactory, name: string, waitMs = OPEN_WAIT_MS): Promise<IDBDatabase | null | "waiting"> {
  if (typeof factory.databases === "function" && !(await factory.databases()).some((db) => db.name === name)) return null;
  // Without databases() (older browsers), or if the database went away since: an open that would create it
  // is aborted, which leaves nothing behind.
  return new Promise((resolve, reject) => {
    const req = factory.open(name);
    let creating = false;
    let gaveUp = false;
    const timer = setTimeout(() => {
      gaveUp = true;
      resolve("waiting");
    }, waitMs);
    req.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) return;
      creating = true;
      req.transaction?.abort();
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      if (gaveUp) return db.close();
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = (event) => {
      clearTimeout(timer);
      if (creating) event.preventDefault();
      if (gaveUp) return;
      if (creating) resolve(null);
      else reject(req.error);
    };
  });
}

/** openDatabase, or "waiting" if it doesn't complete within `waitMs` (see OPEN_WAIT_MS); a late open is closed. */
function openDatabaseWithin(factory: IDBFactory, waitMs = OPEN_WAIT_MS): Promise<IDBDatabase | "waiting"> {
  return new Promise((resolve, reject) => {
    let gaveUp = false;
    const timer = setTimeout(() => {
      gaveUp = true;
      resolve("waiting");
    }, waitMs);
    openDatabase(factory).then(
      (db) => {
        clearTimeout(timer);
        if (gaveUp) db.close();
        else resolve(db);
      },
      (exc: unknown) => {
        clearTimeout(timer);
        if (!gaveUp) reject(exc);
      },
    );
  });
}

interface StoreContents {
  keys: IDBValidKey[];
  values: unknown[];
}

async function readStores(db: IDBDatabase, names: string[]): Promise<Map<string, StoreContents>> {
  const contents = new Map<string, StoreContents>();
  if (!names.length) return contents;
  const tx = db.transaction(names, "readonly");
  const done = finished(tx);
  const reads = names.map(async (name) => {
    const store = tx.objectStore(name);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    contents.set(name, { keys, values });
  });
  await Promise.all([...reads, done]);
  return contents;
}

/** Adds records in one transaction with add(), which never replaces a record: all of them, or none. */
async function addRecords(db: IDBDatabase, contents: Map<string, StoreContents>): Promise<void> {
  if (!contents.size) return;
  const tx = db.transaction([...contents.keys()], "readwrite");
  const done = finished(tx);
  try {
    for (const [name, { keys, values }] of contents) {
      const store = tx.objectStore(name);
      keys.forEach((key, i) => store.add(values[i], key));
    }
  } catch (exc) {
    try {
      tx.abort();
    } catch {
      // Already finished.
    }
    await done.catch(() => {});
    throw exc;
  }
  await done;
}

/** Removes exactly these keys: what one run added, never anything that was there before it. */
async function deleteKeys(db: IDBDatabase, contents: Map<string, StoreContents>): Promise<void> {
  if (!contents.size) return;
  const tx = db.transaction([...contents.keys()], "readwrite");
  for (const [name, { keys }] of contents) for (const key of keys) tx.objectStore(name).delete(key);
  await finished(tx);
}

/** Structural equality for what the stores hold (JSON-like values and dates); anything else counts as different. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

const recordCount = (contents: Map<string, StoreContents>): number => [...contents.values()].reduce((sum, { keys }) => sum + keys.length, 0);

/** The value stored under `key`, or `absent` when there is no such record. */
function lookup(factory: IDBFactory, contents: StoreContents | undefined, key: IDBValidKey): { value: unknown } | "absent" {
  const i = contents?.keys.findIndex((k) => factory.cmp(k, key) === 0) ?? -1;
  return i === -1 ? "absent" : { value: contents!.values[i] };
}

/**
 * Sorts the old records against the new database: `missing` (no record under that key yet, so it can be
 * added), already there with an equal value, or `conflicts` (the new database holds something else there).
 */
function compare(factory: IDBFactory, old: Map<string, StoreContents>, present: Map<string, StoreContents>) {
  const missing = new Map<string, StoreContents>();
  let conflicts = 0;
  for (const [name, { keys, values }] of old) {
    keys.forEach((key, i) => {
      const found = lookup(factory, present.get(name), key);
      if (found === "absent") {
        const entry = missing.get(name) ?? { keys: [], values: [] };
        entry.keys.push(key);
        entry.values.push(values[i]);
        missing.set(name, entry);
      } else if (!deepEqual(found.value, values[i])) {
        conflicts += 1;
      }
    });
  }
  return { missing, conflicts };
}

/** Whether every record of `expected` is in `actual` with an equal value. */
function contains(factory: IDBFactory, actual: Map<string, StoreContents>, expected: Map<string, StoreContents>): boolean {
  for (const [name, { keys, values }] of expected) {
    for (let i = 0; i < keys.length; i++) {
      const found = lookup(factory, actual.get(name), keys[i]!);
      if (found === "absent" || !deepEqual(found.value, values[i])) return false;
    }
  }
  return true;
}

/** Deletes a database: "deleted", or "blocked" while another tab still holds it open (it goes once they close it). */
function deleteDatabase(factory: IDBFactory, name: string): Promise<"deleted" | "blocked"> {
  return new Promise((resolve) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = () => resolve("deleted");
    req.onerror = () => resolve("blocked");
    req.onblocked = () => resolve("blocked");
  });
}

/**
 * - `no-legacy`: there was nothing to move (no old database, or an empty one, now deleted).
 * - `migrated`: everything is in the new database, and the old one is deleted.
 * - `delete-blocked`: everything is in the new database, but another tab still holds the old one open, so
 *   it is deleted only once that tab closes it.
 * - `skipped`: the old database still holds data the new one doesn't have, and nothing replaced anything.
 * - `busy`: a database didn't open in time (another tab holds it up); nothing was checked or moved yet.
 * - `failed`: the move failed; the old database is as it was.
 */
export type MigrationOutcome = "no-legacy" | "migrated" | "delete-blocked" | "skipped" | "busy" | "failed";

export interface MigrationReport {
  outcome: MigrationOutcome;
  /** Records this run added to the new database. */
  moved: number;
  /** Old records left where they were, because the new database holds something else under their key. */
  kept: number;
}

/** The lock two tabs take turns on, so that only one moves the data. */
export const MIGRATION_LOCK = "curatune-web-migrate";

/** What the move needs of the Web Locks API (`navigator.locks`); null where the browser lacks it. */
export type MigrationLocks = Pick<LockManager, "request"> | null;

function defaultLocks(): MigrationLocks {
  return (globalThis as { navigator?: Navigator }).navigator?.locks ?? null;
}

function defaultFactory(): IDBFactory | undefined {
  return typeof indexedDB === "undefined" ? undefined : indexedDB;
}

/** Runs `move` holding the migration lock, or unguarded where there are no Web Locks. */
async function withLock(locks: MigrationLocks, move: () => Promise<MigrationReport>): Promise<MigrationReport> {
  if (!locks) return move();
  let started = false;
  try {
    return await locks.request(MIGRATION_LOCK, () => {
      started = true;
      return move();
    });
  } catch {
    // The lock itself failed (move never throws): move without it, unless it already ran.
    return started ? { outcome: "failed", moved: 0, kept: 0 } : move();
  }
}

/** True only when the browser says the old database doesn't exist: no need to take the lock then. */
async function knownAbsent(factory: IDBFactory): Promise<boolean> {
  try {
    return typeof factory.databases === "function" && !(await factory.databases()).some((db) => db.name === LEGACY_DB_NAME);
  } catch {
    return false;
  }
}

/**
 * Moves the old database's records into the new one, holding the lock (every check happens in here, so a
 * second tab finds the work done). `onlyIntoEmpty` is the one-time move at start, which copies nothing
 * into a new database that already holds data; otherwise (the retry) it adds the records whose keys are
 * missing, without replacing any.
 */
async function moveLegacyData(factory: IDBFactory, onlyIntoEmpty: boolean): Promise<MigrationReport> {
  const report = (outcome: MigrationOutcome, moved = 0, kept = 0): MigrationReport => ({ outcome, moved, kept });
  let legacy: IDBDatabase | null = null;
  let current: IDBDatabase | null = null;
  let added: Map<string, StoreContents> | null = null;
  const removeLegacy = async (): Promise<"migrated" | "delete-blocked"> => {
    legacy?.close();
    legacy = null;
    return (await deleteDatabase(factory, LEGACY_DB_NAME)) === "deleted" ? "migrated" : "delete-blocked";
  };
  try {
    const opened = await openIfExists(factory, LEGACY_DB_NAME);
    // Held up by another tab (most likely a pending deletion of it, but nothing says so): try again later.
    if (opened === "waiting") return report("busy");
    legacy = opened;
    if (!legacy) return report("no-legacy");
    const names = Array.from(legacy.objectStoreNames);
    // A store this version doesn't have would be lost: keep everything where it is.
    if (names.some((name) => !(STORES as readonly string[]).includes(name))) return report("failed");
    const old = await readStores(legacy, names);
    // An old tab of the app recreates the old database, empty, when it reopens it after the move.
    if (recordCount(old) === 0) {
      await removeLegacy();
      return report("no-legacy");
    }
    const currentOpened = await openDatabaseWithin(factory);
    if (currentOpened === "waiting") return report("busy");
    current = currentOpened;
    const present = await readStores(current, Array.from(current.objectStoreNames));
    const { missing, conflicts } = compare(factory, old, present);
    // Everything is already there (an earlier run whose deletion was blocked, or another tab).
    if (!missing.size && !conflicts) return report(await removeLegacy());
    if (onlyIntoEmpty && recordCount(present) > 0) return report("skipped", 0, recordCount(missing) + conflicts);
    await addRecords(current, missing);
    added = missing;
    if (!contains(factory, await readStores(current, [...missing.keys()]), missing)) throw new Error("The copy differs from the original.");
    const moved = recordCount(missing);
    added = null;
    if (conflicts) return report("skipped", moved, conflicts);
    return report(await removeLegacy(), moved);
  } catch {
    // Take back only what this run added: the new database may hold newer data of its own.
    if (added && current) await deleteKeys(current, added).catch(() => {});
    return report("failed");
  } finally {
    legacy?.close();
    current?.close();
  }
}

/**
 * Moves the data kept under the database's former name (LEGACY_DB_NAME) into DB_NAME, once, on start:
 * - only when the old database holds data and the new one is missing or empty ("skipped" otherwise, and
 *   nothing changes); the new one is created at the current version and schema;
 * - the records are added in one transaction, read back, and compared with the original;
 * - a database that doesn't open within OPEN_WAIT_MS (another tab holding it up) means "busy": nothing is
 *   checked or moved, and the lock is released;
 * - only a complete copy deletes the old database ("delete-blocked" while another tab holds it open). On a
 *   failure the old one stays as it was, the new one loses what this run added, and the app goes on.
 * Two tabs take turns through the Web Locks API. Running it again, or without an old database, does
 * nothing. Never throws.
 */
export async function migrateLegacyDatabase(factory: IDBFactory, locks: MigrationLocks = defaultLocks()): Promise<MigrationOutcome> {
  if (await knownAbsent(factory)) return "no-legacy";
  return (await withLock(locks, () => moveLegacyData(factory, true))).outcome;
}

/**
 * The retry after a move that couldn't finish: adds the old records whose keys the new database lacks, with
 * add(), never replacing a record. The old database is deleted only when nothing of it is left behind;
 * `kept` counts the records left because the new database holds something else under their key.
 */
export async function mergeLegacyDatabase(
  factory: IDBFactory | undefined = defaultFactory(),
  locks: MigrationLocks = defaultLocks(),
): Promise<MigrationReport> {
  if (!factory) return { outcome: "failed", moved: 0, kept: 0 };
  if (await knownAbsent(factory)) return { outcome: "no-legacy", moved: 0, kept: 0 };
  return withLock(locks, () => moveLegacyData(factory, false));
}

// One connection per factory (the browser's, or a test's), opened after the move has run.
const connections = new WeakMap<IDBFactory, Promise<IDBDatabase>>();
const outcomes = new WeakMap<IDBFactory, MigrationOutcome>();

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  let connection = connections.get(factory);
  if (!connection) {
    const forget = () => {
      if (connections.get(factory) === connection) connections.delete(factory);
    };
    connection = migrateLegacyDatabase(factory).then((outcome) => {
      outcomes.set(factory, outcome);
      return openDatabase(factory, forget);
    });
    connection.catch(forget);
    connections.set(factory, connection);
  }
  return connection;
}

/** What the one-time move did when the app opened its database; undefined until then, or without IndexedDB. */
export function migrationOutcome(factory: IDBFactory | undefined = defaultFactory()): MigrationOutcome | undefined {
  return factory ? outcomes.get(factory) : undefined;
}

export class IndexedDbStore implements KeyValueStore {
  constructor(
    private readonly store: StoreName,
    private readonly factory: IDBFactory,
  ) {}

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await openDb(this.factory)).transaction(this.store, mode).objectStore(this.store);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await request((await this.tx("readonly")).get(key))) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    await request((await this.tx("readwrite")).put(value, key));
  }

  async delete(key: string): Promise<void> {
    await request((await this.tx("readwrite")).delete(key));
  }

  async keys(): Promise<string[]> {
    return (await request((await this.tx("readonly")).getAllKeys())).map(String);
  }
}

/**
 * How long to wait for the database. Opening can block indefinitely when another tab still runs an older
 * version of the app with the database open (a version upgrade waits for it to close).
 */
const OPEN_TIMEOUT_MS = 3000;

/**
 * IndexedDB when available, memory otherwise (the app still works, but nothing survives a reload).
 * `factory` is the browser's IndexedDB unless a test passes its own.
 */
export async function openStore(name: StoreName, factory?: IDBFactory): Promise<KeyValueStore> {
  try {
    const idb = factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
    if (!idb) return new MemoryStore();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("IndexedDB open timed out")), OPEN_TIMEOUT_MS);
    });
    try {
      await Promise.race([openDb(idb), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return new IndexedDbStore(name, idb);
  } catch {
    return new MemoryStore();
  }
}

/** Whether this browser offers IndexedDB at all (private modes of some browsers do not). */
export function indexedDbSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

/** False for the in-memory fallback: data kept there is lost on reload. */
export function isPersistent(store: KeyValueStore): boolean {
  return !(store instanceof MemoryStore);
}
