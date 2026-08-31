import { LatLng, latLng, bounds, wrapLng, type LatLngBoundsLike, type LatLngLike } from "../geo.js";

export type SpatialId = string | number;

export interface SpatialRecord<TValue, TId extends SpatialId = SpatialId> {
  id: TId;
  position: LatLng;
  value: TValue;
}

interface StoredRecord<TValue, TId extends SpatialId> extends SpatialRecord<TValue, TId> {
  cell: number;
  prev: TId | null;
  next: TId | null;
}

export class SpatialGridIndex<TValue, TId extends SpatialId = SpatialId> {
  readonly cellSize: number;
  readonly records = new Map<TId, StoredRecord<TValue, TId>>();
  /** Packed cell id → linked-list head id. */
  readonly cells = new Map<number, TId>();
  readonly xCellCount: number;
  readonly yCellCount: number;

  constructor(cellSize = 1) {
    const numericSize = Number(cellSize);
    if (!Number.isFinite(numericSize) || numericSize <= 0 || numericSize > 180) {
      throw new RangeError("SpatialGridIndex cellSize must be between 0 and 180 degrees");
    }
    this.cellSize = numericSize;
    this.xCellCount = Math.ceil(360 / numericSize);
    this.yCellCount = Math.ceil(180 / numericSize);
  }

  get size(): number { return this.records.size; }
  get cellCount(): number { return this.cells.size; }

  set(id: TId, position: LatLngLike, value: TValue): this {
    const next = latLng(position);
    return this.setLatLng(id, next.lat, next.lng, value);
  }

  /** Skip `latLng()` parsing — used for 100k–1M point ingest. */
  setLatLng(id: TId, latitude: number, longitude: number, value: TValue): this {
    const lat = Math.max(-90, Math.min(90, latitude));
    const lng = wrapLng(longitude);
    const cell = this.#cellId(lng, lat);
    const existing = this.records.get(id);
    if (existing) {
      existing.value = value;
      existing.position = new LatLng(lat, lng);
      if (existing.cell === cell) return this;
      this.#unlink(existing);
      existing.cell = cell;
      this.#link(existing);
      return this;
    }
    const record: StoredRecord<TValue, TId> = {
      id,
      position: new LatLng(lat, lng),
      value,
      cell,
      prev: null,
      next: null
    };
    this.records.set(id, record);
    this.#link(record);
    return this;
  }

  get(id: TId): SpatialRecord<TValue, TId> | undefined {
    const record = this.records.get(id);
    return record ? this.#publicRecord(record) : undefined;
  }

  has(id: TId): boolean { return this.records.has(id); }

  delete(id: TId): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    this.#unlink(record);
    this.records.delete(id);
    return true;
  }

  clear(): void {
    this.records.clear();
    this.cells.clear();
  }

  values(): Array<SpatialRecord<TValue, TId>> {
    return Array.from(this.records.values(), (record) => this.#publicRecord(record));
  }

  search(
    value: LatLngBoundsLike,
    predicate?: (record: SpatialRecord<TValue, TId>) => boolean
  ): Array<SpatialRecord<TValue, TId>> {
    const result: Array<SpatialRecord<TValue, TId>> = [];
    this.#forEachInBounds(value, (record) => {
      const publicRecord = this.#publicRecord(record);
      if (!predicate || predicate(publicRecord)) result.push(publicRecord);
    });
    return result;
  }

  searchIds(
    value: LatLngBoundsLike,
    predicate?: (id: TId, value: TValue) => boolean
  ): TId[] {
    const result: TId[] = [];
    this.#forEachInBounds(value, (record) => {
      if (!predicate || predicate(record.id, record.value)) result.push(record.id);
    });
    return result;
  }

  #forEachInBounds(
    value: LatLngBoundsLike,
    visit: (record: StoredRecord<TValue, TId>) => void
  ): void {
    const area = bounds(value);
    if (!area.isValid()) return;
    const south = Math.max(-90, area.south);
    const north = Math.min(90, area.north);
    if (south > north) return;

    const rawWidth = Math.abs(area.east - area.west);
    const fullWorld = rawWidth >= 360;
    const west = wrapLng(area.west);
    const east = wrapLng(area.east);
    const longitudeRanges: Array<[number, number]> = fullWorld
      ? [[-180, 180]]
      : west <= east
        ? [[west, east]]
        : [[west, 180], [-180, east]];

    const minY = this.#yFor(south);
    const maxY = this.#yFor(north);
    let estimatedCells = 0;
    for (const [rangeWest, rangeEast] of longitudeRanges) {
      estimatedCells += (this.#xFor(rangeEast) - this.#xFor(rangeWest) + 1) * (maxY - minY + 1);
    }

    const candidates = estimatedCells > this.cells.size * 4
      ? this.records.values()
      : this.#recordsInCells(longitudeRanges, minY, maxY);
    // Only an antimeridian query has more than one longitude range, and every other query pays for
    // the general form: a closure, a destructure and a call per candidate, tens of thousands of
    // times a frame. Hoist the single range into two numbers and compare them directly.
    const singleRange = longitudeRanges.length === 1;
    const onlyWest = longitudeRanges[0][0];
    const onlyEast = longitudeRanges[0][1];
    for (const record of candidates) {
      const { lat, lng } = record.position;
      if (lat < south || lat > north) continue;
      if (!fullWorld) {
        if (singleRange) {
          if (lng < onlyWest || lng > onlyEast) continue;
        } else if (!longitudeRanges.some(([rangeWest, rangeEast]) => lng >= rangeWest && lng <= rangeEast)) {
          continue;
        }
      }
      visit(record);
    }
  }

  /**
   * Visit what is inside `bounds` without building anything: no public record, no cloned position,
   * no result array. `search()` stays the safe copy for callers outside the library, and
   * `searchIds()` still hands back an array; this is for the paths that consume each hit once —
   * hit testing, viewport culling, cluster queries — where the intermediate is pure overhead.
   */
  forEachInBoundsRaw(
    value: LatLngBoundsLike,
    visit: (id: TId, lat: number, lng: number, value: TValue) => void
  ): void {
    this.#forEachInBounds(value, (record) => {
      visit(record.id, record.position.lat, record.position.lng, record.value);
    });
  }

  *#recordsInCells(
    longitudeRanges: Array<[number, number]>,
    minY: number,
    maxY: number
  ): IterableIterator<StoredRecord<TValue, TId>> {
    // A record lives in exactly one cell and each cell is walked once, so the same record can only
    // come back twice when two longitude ranges overlap it — which is the antimeridian split alone.
    // Every ordinary query was allocating and filling a Set that could never reject anything.
    const yielded = longitudeRanges.length > 1 ? new Set<TId>() : null;
    for (const [west, east] of longitudeRanges) {
      const minX = this.#xFor(west);
      const maxX = this.#xFor(east);
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          let cursor: TId | null | undefined = this.cells.get(this.#packCell(x, y));
          while (cursor != null) {
            const record = this.records.get(cursor);
            if (!record) break;
            const next = record.next;
            if (yielded) {
              if (!yielded.has(cursor)) {
                yielded.add(cursor);
                yield record;
              }
            } else {
              yield record;
            }
            cursor = next;
          }
        }
      }
    }
  }

  #link(record: StoredRecord<TValue, TId>): void {
    const head = this.cells.get(record.cell);
    record.prev = null;
    record.next = head ?? null;
    if (head !== undefined) {
      const current = this.records.get(head);
      if (current) current.prev = record.id;
    }
    this.cells.set(record.cell, record.id);
  }

  #unlink(record: StoredRecord<TValue, TId>): void {
    if (record.prev != null) {
      const prev = this.records.get(record.prev);
      if (prev) prev.next = record.next;
    } else if (this.cells.get(record.cell) === record.id) {
      if (record.next != null) this.cells.set(record.cell, record.next);
      else this.cells.delete(record.cell);
    }
    if (record.next != null) {
      const next = this.records.get(record.next);
      if (next) next.prev = record.prev;
    }
    record.prev = null;
    record.next = null;
  }

  #cellId(longitude: number, latitude: number): number {
    return this.#packCell(this.#xFor(longitude), this.#yFor(latitude));
  }

  #packCell(x: number, y: number): number {
    return y * this.xCellCount + x;
  }

  #xFor(longitude: number): number {
    return Math.max(0, Math.min(this.xCellCount - 1, Math.floor((longitude + 180) / this.cellSize)));
  }

  #yFor(latitude: number): number {
    return Math.max(0, Math.min(this.yCellCount - 1, Math.floor((latitude + 90) / this.cellSize)));
  }

  #publicRecord(record: StoredRecord<TValue, TId>): SpatialRecord<TValue, TId> {
    return { id: record.id, position: record.position.clone(), value: record.value };
  }
}

export function spatialGridIndex<TValue, TId extends SpatialId = SpatialId>(cellSize?: number): SpatialGridIndex<TValue, TId> {
  return new SpatialGridIndex<TValue, TId>(cellSize);
}
