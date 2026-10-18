/** Short-lived cache of plaintext DEKs. Entries are zeroed on eviction. */
export class DekCache {
  private readonly entries = new Map<string, { key: Buffer; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max = 256,
  ) {}

  // Returns a cached key, or loads and caches it if missing or expired.
  get(id: string, load: () => Buffer): Buffer {
    const now = Date.now();
    const hit = this.entries.get(id);
    if (hit && hit.expires > now) return hit.key;
    if (hit) this.evict(id);
    this.sweep(now);
    const key = load();
    this.entries.set(id, { key, expires: now + this.ttlMs });
    return key;
  }

  // Evicts (and zeroes) every cached key.
  clear(): void {
    for (const id of [...this.entries.keys()]) this.evict(id);
  }

  // Drops expired entries, then the oldest ones while over capacity.
  private sweep(now: number) {
    for (const [id, e] of this.entries) if (e.expires <= now) this.evict(id);
    while (this.entries.size >= this.max) this.evict(this.entries.keys().next().value!);
  }

  // Overwrites the key bytes with zeros before forgetting it.
  private evict(id: string) {
    this.entries.get(id)?.key.fill(0);
    this.entries.delete(id);
  }
}
