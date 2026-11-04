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

/** Opens a database at whatever version it has, only if it exists: never creates one. */
async function openIfExists(factory: IDBFactory, name: string): Promise<IDBDatabase | null> {
  if (typeof factory.databases === "function" && !(await factory.databases()).some((db) => db.name === name)) return null;
  // Without databases() (older browsers), or if the database went away since: an open that would create it
  // is aborted, which leaves nothing behind.
  return new Promise((resolve, reject) => {
    const req = factory.open(name);
    let creating = false;
    req.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) return;
      creating = true;
      req.transaction?.abort();
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = (event) => {
      if (!creating) return reject(req.error);
      event.preventDefault();
      resolve(null);
    };
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

/** Writes every record in one transaction: either all of them are stored, or none is. */
async function writeStores(db: IDBDatabase, contents: Map<string, StoreContents>): Promise<void> {
  if (!contents.size) return;
  const tx = db.transaction([...contents.keys()], "readwrite");
  const done = finished(tx);
  try {
    for (const [name, { keys, values }] of contents) {
      const store = tx.objectStore(name);
      keys.forEach((key, i) => store.put(values[i], key));
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

async function isEmpty(db: IDBDatabase): Promise<boolean> {
  const names = Array.from(db.objectStoreNames);
  if (!names.length) return true;
  const tx = db.transaction(names, "readonly");
  const counts = await Promise.all(names.map((name) => request(tx.objectStore(name).count())));
  return counts.every((count) => count === 0);
}

async function clearStores(db: IDBDatabase): Promise<void> {
  const names = Array.from(db.objectStoreNames);
  if (!names.length) return;
  const tx = db.transaction(names, "readwrite");
  for (const name of names) tx.objectStore(name).clear();
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

function sameContents(factory: IDBFactory, original: Map<string, StoreContents>, copy: Map<string, StoreContents>): boolean {
  for (const [name, { keys, values }] of original) {
    const copied = copy.get(name);
    if (!copied || copied.keys.length !== keys.length || copied.values.length !== values.length) return false;
    for (let i = 0; i < keys.length; i++) {
      if (factory.cmp(keys[i]!, copied.keys[i]!) !== 0 || !deepEqual(values[i], copied.values[i])) return false;
    }
  }
  return true;
}

/** Deletes a database. Doesn't wait for other tabs that still hold it open: it goes once they close it. */
function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

export type MigrationOutcome = "no-legacy" | "skipped" | "migrated" | "failed";

/**
 * Moves the data kept under the database's former name (LEGACY_DB_NAME) into DB_NAME, once, on start:
 * - only when the old database exists and the new one is missing or empty ("skipped" otherwise, and nothing
 *   changes); the new one is created at the current version and schema;
 * - every record of every store is copied in one transaction, read back, and compared with the original;
 * - only a complete copy deletes the old database. On any failure the old one stays as it was, the new one
 *   is emptied again (so the next start retries), and the app goes on with the new one.
 * Running it again, or without an old database, does nothing. Never throws.
 */
export async function migrateLegacyDatabase(factory: IDBFactory): Promise<MigrationOutcome> {
  let legacy: IDBDatabase | null = null;
  let current: IDBDatabase | null = null;
  let copying = false;
  try {
    legacy = await openIfExists(factory, LEGACY_DB_NAME);
    if (!legacy) return "no-legacy";
    current = await openDatabase(factory);
    if (!(await isEmpty(current))) return "skipped";
    const names = Array.from(legacy.objectStoreNames);
    // A store this version doesn't have would be lost: keep everything where it is.
    if (names.some((name) => !(STORES as readonly string[]).includes(name))) return "failed";
    const original = await readStores(legacy, names);
    copying = true;
    await writeStores(current, original);
    if (!sameContents(factory, original, await readStores(current, names))) throw new Error("The copy differs from the original.");
    legacy.close();
    legacy = null;
    await deleteDatabase(factory, LEGACY_DB_NAME);
    return "migrated";
  } catch {
    if (copying && current) await clearStores(current).catch(() => {});
    return "failed";
  } finally {
    legacy?.close();
    current?.close();
  }
}

// One connection per factory (the browser's, or a test's), opened after the migration has run.
const connections = new WeakMap<IDBFactory, Promise<IDBDatabase>>();

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  let connection = connections.get(factory);
  if (!connection) {
    const forget = () => {
      if (connections.get(factory) === connection) connections.delete(factory);
    };
    connection = migrateLegacyDatabase(factory).then(() => openDatabase(factory, forget));
    connection.catch(forget);
    connections.set(factory, connection);
  }
  return connection;
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
