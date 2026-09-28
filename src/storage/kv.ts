// Small async key-value stores for data that must survive a reload: the write log and plan backups.
// Never used for tokens (those stay in sessionStorage, see src/spotify/auth.ts); tests/invariants.test.ts
// only allows IndexedDB in this directory.

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

const DB_NAME = "spotikit-web";
const DB_VERSION = 1;
export const STORES = ["write-log", "plan-backups"] as const;
export type StoreName = (typeof STORES)[number];

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export class IndexedDbStore implements KeyValueStore {
  constructor(private readonly store: StoreName) {}

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await openDb()).transaction(this.store, mode).objectStore(this.store);
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

/** IndexedDB when available, memory otherwise (the app still works, but nothing survives a reload). */
export async function openStore(name: StoreName): Promise<KeyValueStore> {
  try {
    if (typeof indexedDB === "undefined") return new MemoryStore();
    await openDb();
    return new IndexedDbStore(name);
  } catch {
    return new MemoryStore();
  }
}
