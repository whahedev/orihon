import {
  LatLng,
  latLng,
  latLngBounds,
  wrapLng,
  type LatLngBoundsLike,
  type LatLngLike
} from "../geo.js";

export type SpatialId = string | number;

export interface SpatialRecord<TValue, TId extends SpatialId = SpatialId> {
  id: TId;
  position: LatLng;
  value: TValue;
}

interface StoredRecord<TValue, TId extends SpatialId> extends SpatialRecord<TValue, TId> {
  cell: string;
}

export class SpatialGridIndex<TValue, TId extends SpatialId = SpatialId> {
  readonly cellSize: number;
  readonly records = new Map<TId, StoredRecord<TValue, TId>>();
  readonly cells = new Map<string, Set<TId>>();
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
    this.delete(id);
    const normalized = latLng(position);
    normalized.lat = Math.max(-90, Math.min(90, normalized.lat));
    normalized.lng = wrapLng(normalized.lng);
    const cell = this.#cellKey(normalized);
    const record: StoredRecord<TValue, TId> = { id, position: normalized, value, cell };
    this.records.set(id, record);
    let bucket = this.cells.get(cell);
    if (!bucket) {
      bucket = new Set<TId>();
      this.cells.set(cell, bucket);
    }
    bucket.add(id);
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
    this.records.delete(id);
    const bucket = this.cells.get(record.cell);
    bucket?.delete(id);
    if (!bucket?.size) this.cells.delete(record.cell);
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
    const bounds = latLngBounds(value);
    if (!bounds.isValid()) return [];
    const south = Math.max(-90, bounds.south);
    const north = Math.min(90, bounds.north);
    if (south > north) return [];

    const rawWidth = Math.abs(bounds.east - bounds.west);
    const fullWorld = rawWidth >= 360;
    const west = wrapLng(bounds.west);
    const east = wrapLng(bounds.east);
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
    const result: Array<SpatialRecord<TValue, TId>> = [];
    for (const record of candidates) {
      const { lat, lng } = record.position;
      if (lat < south || lat > north) continue;
      if (!fullWorld && !longitudeRanges.some(([rangeWest, rangeEast]) => lng >= rangeWest && lng <= rangeEast)) continue;
      const publicRecord = this.#publicRecord(record);
      if (!predicate || predicate(publicRecord)) result.push(publicRecord);
    }
    return result;
  }

  *#recordsInCells(
    longitudeRanges: Array<[number, number]>,
    minY: number,
    maxY: number
  ): IterableIterator<StoredRecord<TValue, TId>> {
    const yielded = new Set<TId>();
    for (const [west, east] of longitudeRanges) {
      const minX = this.#xFor(west);
      const maxX = this.#xFor(east);
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const bucket = this.cells.get(`${x}:${y}`);
          if (!bucket) continue;
          for (const id of bucket) {
            if (yielded.has(id)) continue;
            const record = this.records.get(id);
            if (!record) continue;
            yielded.add(id);
            yield record;
          }
        }
      }
    }
  }

  #cellKey(position: LatLng): string {
    return `${this.#xFor(position.lng)}:${this.#yFor(position.lat)}`;
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
