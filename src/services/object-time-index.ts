import type { ObjectId } from "./object-types.js";

export interface TimedObject {
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ObjectTimeConfig {
  value?: (object: TimedObject) => number | null;
  from?: (object: TimedObject) => number | null;
  to?: (object: TimedObject) => number | null;
}

interface TimeRecord {
  id: ObjectId;
  from: number;
  to: number;
}

/**
 * Temporal filter index.
 * Records sorted by `from`; active range uses lower-bound binary search then a
 * short scan until `from` exceeds the filter upper bound.
 */
export class ObjectTimeIndex {
  private readonly config: ObjectTimeConfig;
  private records: TimeRecord[] = [];
  private byId = new Map<ObjectId, TimeRecord>();
  private indexById = new Map<ObjectId, number>();
  private sorted = false;
  private fromFilter: number | null = null;
  private toFilter: number | null = null;
  private cachedActive: Set<ObjectId> | null = null;
  private cacheValid = false;

  constructor(config: ObjectTimeConfig) {
    this.config = config;
  }

  get active(): boolean {
    return this.fromFilter != null || this.toFilter != null;
  }

  get range(): { from: number | null; to: number | null } {
    return { from: this.fromFilter, to: this.toFilter };
  }

  clear(): void {
    this.records = [];
    this.byId.clear();
    this.indexById.clear();
    this.sorted = true;
    this.cacheValid = false;
    this.cachedActive = null;
  }

  setRange(from: number | null, to: number | null): void {
    this.fromFilter = from == null || !Number.isFinite(from) ? null : from;
    this.toFilter = to == null || !Number.isFinite(to) ? null : to;
    this.cacheValid = false;
    this.cachedActive = null;
  }

  remove(id: ObjectId): void {
    const existing = this.byId.get(id);
    if (!existing) return;
    this.byId.delete(id);
    const index = this.indexById.get(id);
    this.indexById.delete(id);
    if (index !== undefined) {
      const last = this.records.pop();
      if (last && index < this.records.length) {
        this.records[index] = last;
        this.indexById.set(last.id, index);
      }
    }
    this.sorted = false;
    this.cacheValid = false;
  }

  upsert(id: ObjectId, object: TimedObject): void {
    this.remove(id);
    let from: number | null = null;
    let to: number | null = null;
    if (this.config.from || this.config.to) {
      from = this.config.from?.(object) ?? null;
      to = this.config.to?.(object) ?? null;
    } else if (this.config.value) {
      const value = this.config.value(object);
      from = value;
      to = value;
    }
    if (from == null || !Number.isFinite(from)) return;
    if (to == null || !Number.isFinite(to)) to = from;
    if (to < from) {
      const tmp = from;
      from = to;
      to = tmp;
    }
    const record = { id, from, to };
    this.indexById.set(id, this.records.length);
    this.records.push(record);
    this.byId.set(id, record);
    this.sorted = false;
    this.cacheValid = false;
  }

  /** Returns ids visible for the current time range. If inactive, returns null (= all). */
  queryActiveIds(): Set<ObjectId> | null {
    if (!this.active) return null;
    if (this.cacheValid && this.cachedActive) return this.cachedActive;
    this.#ensureSorted();
    const from = this.fromFilter ?? Number.NEGATIVE_INFINITY;
    const to = this.toFilter ?? Number.POSITIVE_INFINITY;
    const out = new Set<ObjectId>();
    // Records sorted by `from`. Stop once starts are past the filter upper bound.
    const end = upperBoundFrom(this.records, to);
    for (let i = 0; i < end; i++) {
      const record = this.records[i];
      if (record.to < from) continue;
      out.add(record.id);
    }
    this.cachedActive = out;
    this.cacheValid = true;
    return out;
  }

  isActive(id: ObjectId): boolean {
    if (!this.active) return true;
    const record = this.byId.get(id);
    if (!record) return false;
    const from = this.fromFilter ?? Number.NEGATIVE_INFINITY;
    const to = this.toFilter ?? Number.POSITIVE_INFINITY;
    return !(record.to < from || record.from > to);
  }

  #ensureSorted(): void {
    if (this.sorted) return;
    this.records.sort((a, b) => a.from - b.from || a.to - b.to || String(a.id).localeCompare(String(b.id)));
    for (let i = 0; i < this.records.length; i++) this.indexById.set(this.records[i].id, i);
    this.sorted = true;
  }
}

/** First index with record.from > value (exclusive upper bound). */
function upperBoundFrom(records: TimeRecord[], value: number): number {
  let lo = 0;
  let hi = records.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (records[mid].from <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
