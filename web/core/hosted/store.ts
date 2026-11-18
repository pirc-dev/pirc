// Where a client of a hosted account keeps what must outlive it: its
// chain, its pre-keys, the label key, and the counters of the envelopes it
// sends, each written before the envelope goes (docs/e2e.md, section 4).
// A page keeps them in IndexedDB (stage 9), the app in its own storage;
// tests in memory. Values are structured-cloneable, so CryptoKeys may be
// kept as they are.

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Everything, for a removal: the device keeps nothing. */
  clear(): Promise<void>;
}

export class MemoryStore implements Store {
  private readonly m = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.m.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.m.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.m.delete(key);
  }

  async clear(): Promise<void> {
    this.m.clear();
  }
}
