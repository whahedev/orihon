import { decodeMVT, type MVTDecodeOptions } from "./mvt.js";
import type { VectorTileCoordinates, VectorTileProvider } from "./vector-tile-layer.js";

export interface PMTilesHeader {
  rootDirectoryOffset: number;
  rootDirectoryLength: number;
  leafDirectoryOffset: number;
  tileDataOffset: number;
  internalCompression: number;
  tileCompression: number;
  tileType: number;
  minZoom: number;
  maxZoom: number;
}

export interface PMTilesEntry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

export interface PMTilesRasterSource {
  getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Blob | null>;
  getTileUrl(z: number, x: number, y: number, signal?: AbortSignal): Promise<string | null>;
  revoke(url: string): void;
}

export class PMTilesArchive {
  private headerPromise: Promise<PMTilesHeader> | null = null;
  private rootPromise: Promise<PMTilesEntry[]> | null = null;
  private wholeArchive: ArrayBuffer | null = null;

  constructor(readonly url: string) {}

  async getHeader(signal?: AbortSignal): Promise<PMTilesHeader> {
    this.headerPromise ??= this.#readHeader(signal);
    return this.headerPromise;
  }

  async getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    const header = await this.getHeader(signal);
    if (z < header.minZoom || z > header.maxZoom) return null;
    const tileId = zxyToTileId(z, x, y);
    this.rootPromise ??= this.#readDirectory(header.rootDirectoryOffset, header.rootDirectoryLength, header.internalCompression, signal);
    let entry = findPMTilesEntry(await this.rootPromise, tileId);
    if (!entry) return null;
    if (entry.runLength === 0) {
      const leaf = await this.#readDirectory(
        header.leafDirectoryOffset + entry.offset,
        entry.length,
        header.internalCompression,
        signal
      );
      entry = findPMTilesEntry(leaf, tileId);
    }
    if (!entry || entry.runLength === 0) return null;
    const bytes = await this.#range(header.tileDataOffset + entry.offset, entry.length, signal);
    return new Uint8Array(await decompressPMTiles(bytes, header.tileCompression));
  }

  async #readHeader(signal?: AbortSignal): Promise<PMTilesHeader> {
    const buffer = await this.#range(0, 127, signal);
    const bytes = new Uint8Array(buffer);
    if (new TextDecoder().decode(bytes.subarray(0, 7)) !== "PMTiles" || bytes[7] !== 3) {
      throw new TypeError("Unsupported PMTiles archive (expected v3)");
    }
    const view = new DataView(buffer);
    const uint64 = (offset: number): number => {
      const value = Number(view.getBigUint64(offset, true));
      if (!Number.isSafeInteger(value)) throw new RangeError("PMTiles offset exceeds JavaScript safe integer range");
      return value;
    };
    return {
      rootDirectoryOffset: uint64(8),
      rootDirectoryLength: uint64(16),
      leafDirectoryOffset: uint64(40),
      tileDataOffset: uint64(56),
      internalCompression: bytes[97],
      tileCompression: bytes[98],
      tileType: bytes[99],
      minZoom: bytes[100],
      maxZoom: bytes[101]
    };
  }

  async #readDirectory(offset: number, length: number, compression: number, signal?: AbortSignal): Promise<PMTilesEntry[]> {
    return deserializePMTilesDirectory(new Uint8Array(await decompressPMTiles(await this.#range(offset, length, signal), compression)));
  }

  async #range(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (this.wholeArchive) return this.wholeArchive.slice(offset, offset + length);
    const response = await fetch(this.url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      signal
    });
    if (!response.ok) throw new Error(`PMTiles range request failed: ${response.status}`);
    const data = await response.arrayBuffer();
    if (response.status === 200) {
      this.wholeArchive = data;
      return data.slice(offset, offset + length);
    }
    return data.byteLength === length ? data : data.slice(0, length);
  }
}

export function createPMTilesProvider(url: string, options: MVTDecodeOptions = {}): VectorTileProvider {
  const archive = new PMTilesArchive(url);
  return async (tile: VectorTileCoordinates) => {
    const bytes = await archive.getTile(tile.z, tile.x, tile.y, tile.signal);
    return bytes ? decodeMVT(bytes, tile, options) : [];
  };
}

export function createPMTilesRasterSource(url: string): PMTilesRasterSource {
  const archive = new PMTilesArchive(url);
  return {
    async getTile(z, x, y, signal) {
      const header = await archive.getHeader(signal);
      const bytes = await archive.getTile(z, x, y, signal);
      if (!bytes) return null;
      const mime = ["application/octet-stream", "application/vnd.mapbox-vector-tile", "image/png", "image/jpeg", "image/webp", "image/avif"][header.tileType]
        ?? "application/octet-stream";
      return new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
    },
    async getTileUrl(z, x, y, signal) {
      const blob = await this.getTile(z, x, y, signal);
      return blob ? URL.createObjectURL(blob) : null;
    },
    revoke(value) { URL.revokeObjectURL(value); }
  };
}

export function deserializePMTilesDirectory(bytes: Uint8Array): PMTilesEntry[] {
  let cursor = 0;
  const read = (): number => {
    let value = 0;
    let shift = 0;
    while (cursor < bytes.length) {
      const byte = bytes[cursor++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
      shift += 7;
      if (shift > 53) throw new RangeError("PMTiles varint exceeds JavaScript safe integer range");
    }
    throw new RangeError("Truncated PMTiles directory");
  };
  const count = read();
  const entries = Array.from({ length: count }, () => ({ tileId: 0, offset: 0, length: 0, runLength: 0 }));
  let tileId = 0;
  for (const entry of entries) { tileId += read(); entry.tileId = tileId; }
  for (const entry of entries) entry.runLength = read();
  for (const entry of entries) entry.length = read();
  let nextOffset = 0;
  for (const entry of entries) {
    const encoded = read();
    entry.offset = encoded === 0 ? nextOffset : encoded - 1;
    nextOffset = entry.offset + entry.length;
  }
  return entries;
}

export function findPMTilesEntry(entries: PMTilesEntry[], tileId: number): PMTilesEntry | null {
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (entries[middle].tileId < tileId) low = middle + 1;
    else if (entries[middle].tileId > tileId) high = middle - 1;
    else return entries[middle];
  }
  const previous = entries[high];
  return previous && (previous.runLength === 0 || tileId - previous.tileId < previous.runLength) ? previous : null;
}

export function zxyToTileId(z: number, x: number, y: number): number {
  if (!Number.isInteger(z) || z < 0 || z > 26) throw new RangeError("PMTiles zoom must be an integer from 0 to 26");
  const size = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= size || y >= size) {
    throw new RangeError("PMTiles tile coordinate is outside its zoom level");
  }
  let distance = 0;
  for (let scale = size / 2; scale >= 1; scale /= 2) {
    const rx = (x & scale) > 0 ? 1 : 0;
    const ry = (y & scale) > 0 ? 1 : 0;
    distance += scale * scale * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = scale - 1 - x; y = scale - 1 - y; }
      [x, y] = [y, x];
    }
  }
  return (4 ** z - 1) / 3 + distance;
}

async function decompressPMTiles(buffer: ArrayBuffer, compression: number): Promise<ArrayBuffer> {
  if (compression === 0 || compression === 1) return buffer;
  const format = compression === 2 ? "gzip" : compression === 3 ? "brotli" : compression === 4 ? "zstd" : "";
  if (!format || typeof DecompressionStream === "undefined") throw new TypeError(`Unsupported PMTiles compression: ${compression}`);
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream(format as CompressionFormat));
  return new Response(stream).arrayBuffer();
}
