/** Inclusive integer tile rectangle at one zoom. */
export interface TileRect {
  z: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
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

/** Key of the tile covering `key` at a coarser zoom. */
export function tileAncestorKey(key: string, targetZoom: number): string | null {
  const tile = parseTileKey(key);
  const z = Math.floor(targetZoom);
  if (!tile || z < 0 || z > tile.z) return null;
  const scale = 2 ** (tile.z - z);
  return `${z}:${Math.floor(tile.x / scale)}:${Math.floor(tile.y / scale)}`;
}

/** Nearest ready parent, used as an opaque raster backstop while a level loads. */
export function nearestReadyAncestorKey(
  key: string,
  isReady: (candidate: string) => boolean,
  minZoom = 0
): string | null {
  const tile = parseTileKey(key);
  if (!tile) return null;
  for (let z = tile.z - 1; z >= Math.max(0, minZoom); z--) {
    const parent = tileAncestorKey(key, z);
    if (parent && isReady(parent)) return parent;
  }
  return null;
}

/**
 * Fraction of a target tile covered by ready exact, parent or child imagery.
 * Parents count as full coverage; children are accumulated without overlap.
 */
function readyTileCoverage(
  key: string,
  isReady: (candidate: string) => boolean,
  descendantDepth: number
): number {
  if (isReady(key)) return 1;
  const tile = parseTileKey(key);
  if (!tile || descendantDepth <= 0) return 0;
  let covered = 0;
  const childZ = tile.z + 1;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      covered += readyTileCoverage(
        `${childZ}:${tile.x * 2 + dx}:${tile.y * 2 + dy}`,
        isReady,
        descendantDepth - 1
      ) / 4;
    }
  }
  return covered;
}

/** Visual coverage of a target tile set, including pyramid fallbacks. */
export function tileSetCoverage(
  needed: Iterable<string>,
  isReady: (candidate: string) => boolean,
  minZoom = 0,
  descendantDepth = 3
): number {
  let total = 0;
  let covered = 0;
  for (const key of needed) {
    total += 1;
    if (isReady(key) || nearestReadyAncestorKey(key, isReady, minZoom)) {
      covered += 1;
    } else {
      covered += readyTileCoverage(key, isReady, Math.max(0, descendantDepth));
    }
  }
  return total ? covered / total : 1;
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
  // panVelocity is the screen/finger motion. The geographic surface and the
  // newly exposed edge move in the opposite direction.
  const predX = centerX - (vx / Math.max(1, tileSize)) * lookaheadSec;
  const predY = centerY - (vy / Math.max(1, tileSize)) * lookaheadSec;
  return Math.hypot(x + 0.5 - predX, y + 0.5 - predY);
}

export interface TileLookaheadPadding {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Extra prefetch strips on the edge a drag/inertia gesture is revealing. */
export function tileLookaheadPadding(
  vx: number,
  vy: number,
  tileSize: number,
  lookaheadSec = 0.35,
  maxTiles = 2
): TileLookaheadPadding {
  const size = Math.max(1, tileSize);
  const limit = Math.max(0, Math.floor(maxTiles));
  const dx = Math.max(-limit, Math.min(limit, (-vx / size) * lookaheadSec));
  const dy = Math.max(-limit, Math.min(limit, (-vy / size) * lookaheadSec));
  return {
    left: Math.max(0, Math.ceil(-dx)),
    right: Math.max(0, Math.ceil(dx)),
    top: Math.max(0, Math.ceil(-dy)),
    bottom: Math.max(0, Math.ceil(dy))
  };
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
