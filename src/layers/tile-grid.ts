/** Inclusive integer tile rectangle at one zoom. */
export interface TileRect {
  z: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function tileRectContains(rect: TileRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function forEachTileInRect(rect: TileRect, visit: (x: number, y: number) => void): void {
  for (let y = rect.top; y <= rect.bottom; y++) {
    for (let x = rect.left; x <= rect.right; x++) visit(x, y);
  }
}

/** Parse `z:x:y` keys produced by the raster/vector tile layers. */
export function parseTileKey(key: string): { z: number; x: number; y: number } | null {
  const i = key.indexOf(":");
  const j = i < 0 ? -1 : key.indexOf(":", i + 1);
  if (i < 0 || j < 0) return null;
  const z = Number(key.slice(0, i));
  const x = Number(key.slice(i + 1, j));
  const y = Number(key.slice(j + 1));
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { z, x, y };
}

/**
 * Tiles in `needed` that were never instantiated — leftover after maxNew-per-frame
 * or after an incremental coverage pass that committed `_rect` too early.
 */
export function forEachMissingNeeded(
  needed: Iterable<string>,
  hasTile: (key: string) => boolean,
  visit: (x: number, y: number, key: string) => void
): void {
  for (const key of needed) {
    if (hasTile(key)) continue;
    const parsed = parseTileKey(key);
    if (parsed) visit(parsed.x, parsed.y, key);
  }
}

/** Visit tiles that left `prev` or entered `next` without walking the overlap. */
export function forEachTileRectDelta(
  prev: TileRect | null,
  next: TileRect,
  onEnter: (x: number, y: number) => void,
  onLeave: (x: number, y: number) => void
): void {
  if (!prev || prev.z !== next.z) {
    if (prev) forEachTileInRect(prev, onLeave);
    forEachTileInRect(next, onEnter);
    return;
  }
  for (let y = prev.top; y <= prev.bottom; y++) {
    if (y < next.top || y > next.bottom) {
      for (let x = prev.left; x <= prev.right; x++) onLeave(x, y);
      continue;
    }
    for (let x = prev.left; x <= prev.right; x++) {
      if (x < next.left || x > next.right) onLeave(x, y);
    }
  }
  for (let y = next.top; y <= next.bottom; y++) {
    if (y < prev.top || y > prev.bottom) {
      for (let x = next.left; x <= next.right; x++) onEnter(x, y);
      continue;
    }
    for (let x = next.left; x <= next.right; x++) {
      if (x < prev.left || x > prev.right) onEnter(x, y);
    }
  }
}

/**
 * Distance from a tile to the predicted camera center (tiles, not pixels).
 * `vx` / `vy` are screen-space pan velocity in px/s.
 */
export function tilePriority(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  vx: number,
  vy: number,
  tileSize: number,
  lookaheadSec = 0.28
): number {
  const predX = centerX + (vx / Math.max(1, tileSize)) * lookaheadSec;
  const predY = centerY + (vy / Math.max(1, tileSize)) * lookaheadSec;
  return Math.hypot(x + 0.5 - predX, y + 0.5 - predY);
}

/** Binary min-heap. Replaces Array#shift on tile download queues. */
export class MinHeap<T> {
  private readonly data: T[] = [];
  constructor(private readonly score: (item: T) => number) {}

  get length(): number {
    return this.data.length;
  }

  clear(): void {
    this.data.length = 0;
  }

  push(item: T): void {
    this.data.push(item);
    this.#up(this.data.length - 1);
  }

  pop(): T | undefined {
    const n = this.data.length;
    if (!n) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (n > 1) {
      this.data[0] = last;
      this.#down(0);
    }
    return top;
  }

  removeWhere(predicate: (item: T) => boolean): void {
    const next: T[] = [];
    for (const item of this.data) if (!predicate(item)) next.push(item);
    this.data.length = 0;
    for (const item of next) this.push(item);
  }

  #up(index: number): void {
    const { data, score } = this;
    const item = data[index];
    const itemScore = score(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (score(data[parent]) <= itemScore) break;
      data[index] = data[parent];
      index = parent;
    }
    data[index] = item;
  }

  #down(index: number): void {
    const { data, score } = this;
    const n = data.length;
    const item = data[index];
    const itemScore = score(item);
    while (true) {
      const left = index * 2 + 1;
      if (left >= n) break;
      const right = left + 1;
      let best = left;
      if (right < n && score(data[right]) < score(data[left])) best = right;
      if (itemScore <= score(data[best])) break;
      data[index] = data[best];
      index = best;
    }
    data[index] = item;
  }
}
