/** Count-Min Sketch with periodic aging (TinyLFU frequency estimator). */
export class CountMinSketch {
  readonly depth: number;
  readonly width: number;
  private readonly rows: Uint8Array[];
  private adds = 0;
  private readonly ageAfter: number;

  constructor(width = 1024, depth = 4, ageAfter = 16_384) {
    this.width = Math.max(32, width);
    this.depth = Math.max(2, depth);
    this.ageAfter = Math.max(256, ageAfter);
    this.rows = Array.from({ length: this.depth }, () => new Uint8Array(this.width));
  }

  hit(key: string): number {
    let min = 255;
    for (let row = 0; row < this.depth; row++) {
      const index = hash32(key, row + 1) % this.width;
      const cell = this.rows[row];
      if (cell[index] < 255) cell[index] += 1;
      if (cell[index] < min) min = cell[index];
    }
    this.adds += 1;
    if (this.adds >= this.ageAfter) this.#age();
    return min;
  }

  estimate(key: string): number {
    let min = 255;
    for (let row = 0; row < this.depth; row++) {
      const index = hash32(key, row + 1) % this.width;
      const value = this.rows[row][index];
      if (value < min) min = value;
    }
    return min === 255 && this.adds === 0 ? 0 : min;
  }

  #age(): void {
    this.adds = 0;
    for (const row of this.rows) {
      for (let i = 0; i < row.length; i++) row[i] >>= 1;
    }
  }
}

/**
 * Window-TinyLFU admission + LRU main cache (Caffeine-style).
 * Values live in the caller; this tracks keys, frequency and eviction order.
 */
export class WTinyLfu {
  readonly capacity: number;
  readonly windowSize: number;
  readonly sketch: CountMinSketch;
  /** Optional access log for later cache-policy replay. */
  readonly trace: Array<{ op: "hit" | "add" | "evict"; key: string }> | null;
  private readonly window = new Map<string, true>();
  private readonly main = new Map<string, true>();

  constructor(capacity: number, options: { trace?: boolean; windowRatio?: number } = {}) {
    const size = Math.max(1, Math.floor(Number(capacity) || 1));
    this.capacity = size;
    const ratio = options.windowRatio ?? (size < 32 ? 0.25 : 0.2);
    this.windowSize = Math.max(1, Math.min(size - 1 || 1, Math.round(size * ratio)));
    this.sketch = new CountMinSketch(Math.max(64, size * 8), 4, Math.max(1024, size * 64));
    this.trace = options.trace ? [] : null;
  }

  get size(): number {
    return this.window.size + this.main.size;
  }

  has(key: string): boolean {
    return this.window.has(key) || this.main.has(key);
  }

  hit(key: string): void {
    this.sketch.hit(key);
    if (this.window.has(key)) {
      this.window.delete(key);
      this.window.set(key, true);
    } else if (this.main.has(key)) {
      this.main.delete(key);
      this.main.set(key, true);
    }
    this.#log("hit", key);
  }

  /** Insert `key`. Returns a victim key when the cache is full. */
  add(key: string): string | undefined {
    if (this.has(key)) {
      this.hit(key);
      return undefined;
    }
    this.sketch.hit(key);
    this.window.set(key, true);
    this.#log("add", key);
    if (this.window.size <= this.windowSize && this.size <= this.capacity) return undefined;
    const candidate = oldestKey(this.window);
    if (!candidate) return undefined;
    this.window.delete(candidate);
    if (this.size < this.capacity) {
      this.main.set(candidate, true);
      return undefined;
    }
    const victim = oldestKey(this.main);
    if (!victim) {
      this.#log("evict", candidate);
      return candidate;
    }
    if (this.sketch.estimate(candidate) >= this.sketch.estimate(victim)) {
      this.main.delete(victim);
      this.main.set(candidate, true);
      this.#log("evict", victim);
      return victim;
    }
    this.#log("evict", candidate);
    return candidate;
  }

  delete(key: string): boolean {
    return this.window.delete(key) || this.main.delete(key);
  }

  /** Evict the least valuable unpinned key. */
  evictExcept(pinned: ReadonlySet<string>): string | undefined {
    const fromWindow = oldestUnpinned(this.window, pinned);
    const fromMain = oldestUnpinned(this.main, pinned);
    let victim: string | undefined;
    if (fromWindow && fromMain) {
      victim = this.sketch.estimate(fromWindow) <= this.sketch.estimate(fromMain) ? fromWindow : fromMain;
    } else {
      victim = fromWindow ?? fromMain;
    }
    if (!victim) return undefined;
    this.delete(victim);
    this.#log("evict", victim);
    return victim;
  }

  #log(op: "hit" | "add" | "evict", key: string): void {
    this.trace?.push({ op, key });
  }
}

export function wTinyLfu(capacity: number, options?: { trace?: boolean; windowRatio?: number }): WTinyLfu {
  return new WTinyLfu(capacity, options);
}

function oldestKey(map: Map<string, true>): string | undefined {
  return map.keys().next().value;
}

function oldestUnpinned(map: Map<string, true>, pinned: ReadonlySet<string>): string | undefined {
  for (const key of map.keys()) if (!pinned.has(key)) return key;
  return undefined;
}

function hash32(key: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
