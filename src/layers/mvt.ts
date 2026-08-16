import type { GeoJSONFeature, GeoJSONGeometry, GeoJSONPosition } from "./geojson.js";
import type { VectorTileCoordinates, VectorTileProvider } from "./vector-tile-layer.js";

type PbfValue = string | number | boolean | null;

export interface MVTDecodeOptions {
  layer?: string | string[];
  idProperty?: string;
  /** Skip decode when the buffer is larger than this. Default 2 MiB. */
  maxBytes?: number;
  /** Stop after this many features. Default 16384. */
  maxFeatures?: number;
  /** Drop protobuf strings longer than this. Default 8192. */
  maxStringLength?: number;
}

export interface PackedMVTLayer {
  name: string;
  extent: number;
  keys: string[];
  values: PbfValue[];
  /** Interleaved tile-local x,y (extent units). */
  xy: Int32Array<ArrayBufferLike>;
  types: Uint8Array<ArrayBufferLike>;
  ids: Array<string | number | undefined>;
  /** Vertex index start per feature; length = featureCount + 1. */
  vertexOffsets: Uint32Array<ArrayBufferLike>;
  /** Index into `partEnds` per feature; length = featureCount + 1. */
  partOffsets: Uint32Array<ArrayBufferLike>;
  /** Exclusive vertex index for each ring / line. */
  partEnds: Uint32Array<ArrayBufferLike>;
  /** Index into `tags` per feature; length = featureCount + 1. */
  tagOffsets: Uint32Array<ArrayBufferLike>;
  tags: Uint32Array<ArrayBufferLike>;
}

export interface PackedVectorTile {
  x: number;
  y: number;
  z: number;
  layers: PackedMVTLayer[];
}

const packedMvt = createPackedMvtRuntime();

export type PackedTileDecoder = (
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options?: MVTDecodeOptions
) => PackedVectorTile | null;

const packedSniffers: PackedTileDecoder[] = [];
let packedMvtWasm: PackedTileDecoder | null = null;

/** Optional `orihon/mlt` (and Advanced `orihon`) registers a sniffer so `decodePackedMVT` / `createMVTProvider` accept MLT. */
export function registerPackedTileSniffer(sniff: PackedTileDecoder): void {
  if (!packedSniffers.includes(sniff)) packedSniffers.push(sniff);
}

/** Optional `orihon/mvt-wasm` (and Advanced `orihon`) registers a WASM packed decoder used before the JS MVT path. */
export function registerPackedMvtWasm(decoder: PackedTileDecoder | null): void {
  packedMvtWasm = decoder;
}

/** JS protobuf path — WASM/MLT fallbacks must call this, not `decodePackedMVT`. */
export function decodePackedMVTJs(
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions = {}
): PackedVectorTile {
  return packedMvt.decodePackedMVT(data, tile, options);
}

export function decodePackedMVT(
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions = {}
): PackedVectorTile {
  return decodePackedMVTRouted(data, tile, options);
}

function decodePackedMVTRouted(
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions
): PackedVectorTile {
  const sniffed = sniffPackedTile(data, tile, options);
  if (sniffed) return sniffed;
  if (packedMvtWasm) {
    const packed = packedMvtWasm(data, tile, options);
    if (packed) return packed;
  }
  return packedMvt.decodePackedMVT(data, tile, options);
}

function sniffPackedTile(
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions
): PackedVectorTile | null {
  for (const sniff of packedSniffers) {
    try {
      const packed = sniff(data, tile, options);
      if (packed != null) return packed;
    } catch {
      // Not this format — try the next sniffer / MVT path.
    }
  }
  return null;
}

export function packedToGeoJSON(packed: PackedVectorTile, options: MVTDecodeOptions = {}): GeoJSONFeature[] {
  return packedMvt.packedToGeoJSON(packed, options);
}

export function decodeMVT(
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions = {}
): GeoJSONFeature[] {
  return packedToGeoJSON(decodePackedMVT(data, tile, options), options);
}

export function createMVTProvider(
  urlTemplate: string | ((tile: VectorTileCoordinates) => string),
  options: MVTDecodeOptions = {}
): VectorTileProvider {
  return async (tile) => {
    const url = typeof urlTemplate === "function"
      ? urlTemplate(tile)
      : urlTemplate
        .replaceAll("{x}", String(tile.x))
        .replaceAll("{y}", String(tile.y))
        .replaceAll("{z}", String(tile.z));
    const response = await fetch(url, { signal: tile.signal });
    if (!response.ok) throw new Error(`MVT request failed: ${response.status}`);
    const buffer = await response.arrayBuffer();
    const packed = await decodePackedMVTAsync(buffer, tile, options);
    return packedToGeoJSON(packed, options);
  };
}

export function packedMvtWorkerSource(): string {
  return "var r=(" + createPackedMvtRuntime.toString() + ")();\n(" + packedMvtWorkerMain.toString() + ")(r);";
}

export async function decodePackedMVTAsync(
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions = {}
): Promise<PackedVectorTile> {
  const sniffed = sniffPackedTile(data, tile, options);
  if (sniffed) return sniffed;
  if (packedMvtWasm) {
    const packed = packedMvtWasm(data, tile, options);
    if (packed) return packed;
  }
  const worker = mvtWorker();
  if (!worker) return decodePackedMVTJs(data, tile, options);
  const bytes = data instanceof Uint8Array
    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    : data.slice(0);
  const id = ++mvtRequestId;
  return new Promise((resolve, reject) => {
    mvtPending.set(id, { resolve, reject });
    worker.postMessage({ id, bytes, tile, options }, [bytes]);
  });
}

let mvtRequestId = 0;
let mvtWorkerInstance: Worker | null = null;
let mvtWorkerUrl: string | null = null;
const mvtPending = new Map<number, {
  resolve: (value: PackedVectorTile) => void;
  reject: (reason: unknown) => void;
}>();

function mvtWorker(): Worker | null {
  if (mvtWorkerInstance) return mvtWorkerInstance;
  if (typeof document === "undefined" || typeof Worker === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") return null;
  try {
    const blob = new Blob([packedMvtWorkerSource()], { type: "text/javascript" });
    mvtWorkerUrl = URL.createObjectURL(blob);
    mvtWorkerInstance = new Worker(mvtWorkerUrl);
    mvtWorkerInstance.onmessage = (event: MessageEvent) => {
      const data = event.data || {};
      const pending = mvtPending.get(data.id);
      if (!pending) return;
      mvtPending.delete(data.id);
      if (data.error) pending.reject(new Error(String(data.error)));
      else pending.resolve(revivePackedTile(data.packed));
    };
    mvtWorkerInstance.onerror = () => {
      mvtWorkerInstance?.terminate();
      mvtWorkerInstance = null;
      if (mvtWorkerUrl) URL.revokeObjectURL(mvtWorkerUrl);
      mvtWorkerUrl = null;
      for (const pending of mvtPending.values()) pending.reject(new Error("MVT worker failed"));
      mvtPending.clear();
    };
    return mvtWorkerInstance;
  } catch {
    if (mvtWorkerUrl) URL.revokeObjectURL(mvtWorkerUrl);
    mvtWorkerUrl = null;
    return null;
  }
}

function revivePackedTile(raw: PackedVectorTile): PackedVectorTile {
  return {
    x: raw.x,
    y: raw.y,
    z: raw.z,
    layers: (raw.layers || []).map((layer) => ({
      ...layer,
      xy: layer.xy instanceof Int32Array ? layer.xy : new Int32Array(layer.xy as ArrayLike<number>),
      types: layer.types instanceof Uint8Array ? layer.types : new Uint8Array(layer.types as ArrayLike<number>),
      vertexOffsets: layer.vertexOffsets instanceof Uint32Array ? layer.vertexOffsets : new Uint32Array(layer.vertexOffsets as ArrayLike<number>),
      partOffsets: layer.partOffsets instanceof Uint32Array ? layer.partOffsets : new Uint32Array(layer.partOffsets as ArrayLike<number>),
      partEnds: layer.partEnds instanceof Uint32Array ? layer.partEnds : new Uint32Array(layer.partEnds as ArrayLike<number>),
      tagOffsets: layer.tagOffsets instanceof Uint32Array ? layer.tagOffsets : new Uint32Array(layer.tagOffsets as ArrayLike<number>),
      tags: layer.tags instanceof Uint32Array ? layer.tags : new Uint32Array(layer.tags as ArrayLike<number>)
    }))
  };
}

function packedMvtWorkerMain(runtime: ReturnType<typeof createPackedMvtRuntime>): void {
  const scope = globalThis as typeof globalThis & {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: (message: unknown, transfer?: Transferable[]) => void;
  };
  scope.onmessage = function (event: MessageEvent) {
    const data = (event.data || {}) as {
      id?: unknown;
      bytes?: ArrayBuffer;
      tile?: { x: number; y: number; z: number };
      options?: MVTDecodeOptions;
    };
    try {
      const packed = runtime.decodePackedMVT(new Uint8Array(data.bytes || new ArrayBuffer(0)), data.tile || { x: 0, y: 0, z: 0 }, data.options || {});
      const transfer: Transferable[] = [];
      for (const layer of packed.layers) {
        transfer.push(
          layer.xy.buffer,
          layer.types.buffer,
          layer.vertexOffsets.buffer,
          layer.partOffsets.buffer,
          layer.partEnds.buffer,
          layer.tagOffsets.buffer,
          layer.tags.buffer
        );
      }
      scope.postMessage({ id: data.id, packed }, transfer);
    } catch (error) {
      scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

function createPackedMvtRuntime() {
  const textDecoder = typeof TextDecoder === "undefined" ? null : new TextDecoder();

  function zigZag(value: number): number {
    return (value >> 1) ^ -(value & 1);
  }

  class PbfReader {
    position: number;
    view: DataView;
    constructor(
      readonly bytes: Uint8Array,
      readonly end: number,
      readonly maxLength: number,
      readonly maxString: number,
      position = 0
    ) {
      this.position = position;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    get done(): boolean { return this.position >= this.end; }
    fork(start: number, end: number): PbfReader {
      return new PbfReader(this.bytes, end, this.maxLength, this.maxString, start);
    }
    tag(): { field: number; wire: number } {
      const value = this.varint();
      return { field: value >> 3, wire: value & 7 };
    }
    varint(): number {
      let result = 0;
      let shift = 0;
      while (this.position < this.end) {
        const byte = this.bytes[this.position++];
        result += (byte & 0x7f) * 2 ** shift;
        if (byte < 0x80) break;
        shift += 7;
      }
      return result;
    }
    svarint(): number { return zigZag(this.varint()); }
    readRange(): { start: number; end: number } {
      const length = this.varint();
      if (length < 0 || length > this.maxLength || this.position + length > this.end) {
        this.position = this.end;
        return { start: this.position, end: this.position };
      }
      const start = this.position;
      this.position += length;
      return { start, end: start + length };
    }
    packedVarints(): Uint32Array {
      const range = this.readRange();
      const child = this.fork(range.start, range.end);
      let cap = 32;
      let values = new Uint32Array(cap);
      let n = 0;
      while (!child.done) {
        if (n >= cap) {
          cap *= 2;
          const next = new Uint32Array(cap);
          next.set(values);
          values = next;
        }
        values[n++] = child.varint() >>> 0;
      }
      return new Uint32Array(values.subarray(0, n));
    }
    string(): string {
      const range = this.readRange();
      const length = range.end - range.start;
      if (length <= 0 || length > this.maxString) return "";
      const slice = this.bytes.subarray(range.start, range.end);
      return textDecoder ? textDecoder.decode(slice) : "";
    }
    float(): number {
      if (this.position + 4 > this.end) {
        this.position = this.end;
        return 0;
      }
      const value = this.view.getFloat32(this.position, true);
      this.position += 4;
      return value;
    }
    double(): number {
      if (this.position + 8 > this.end) {
        this.position = this.end;
        return 0;
      }
      const value = this.view.getFloat64(this.position, true);
      this.position += 8;
      return value;
    }
    skip(wire: number): void {
      if (wire === 0) this.varint();
      else if (wire === 1) this.position += 8;
      else if (wire === 2) this.position += this.varint();
      else if (wire === 5) this.position += 4;
      else this.position = this.end;
    }
  }

  function growInt32(buffer: Int32Array<ArrayBufferLike>, min: number): Int32Array<ArrayBufferLike> {
    if (buffer.length >= min) return buffer;
    const next = new Int32Array(Math.max(min, buffer.length * 2 || min));
    next.set(buffer);
    return next;
  }

  function growUint32(buffer: Uint32Array<ArrayBufferLike>, min: number): Uint32Array<ArrayBufferLike> {
    if (buffer.length >= min) return buffer;
    const next = new Uint32Array(Math.max(min, buffer.length * 2 || min));
    next.set(buffer);
    return next;
  }

  function readValue(reader: PbfReader): PbfValue {
    let value: PbfValue = null;
    while (!reader.done) {
      const { field, wire } = reader.tag();
      if (field === 1 && wire === 2) value = reader.string();
      else if (field === 2 && wire === 5) value = reader.float();
      else if (field === 3 && wire === 1) value = reader.double();
      else if (field === 4 && wire === 0) value = reader.varint();
      else if (field === 5 && wire === 0) value = reader.svarint();
      else if (field === 6 && wire === 0) value = Boolean(reader.varint());
      else reader.skip(wire);
    }
    return value;
  }

  function decodeGeometry(
    commands: Uint32Array<ArrayBufferLike>,
    xy: Int32Array<ArrayBufferLike>,
    write: number,
    partEnds: Uint32Array<ArrayBufferLike>,
    partWrite: number
  ): {
    xy: Int32Array<ArrayBufferLike>;
    write: number;
    partEnds: Uint32Array<ArrayBufferLike>;
    partWrite: number;
  } {
    let cursor = 0;
    let x = 0;
    let y = 0;
    let partStart = write;
    const flush = (): void => {
      if (write > partStart) {
        partEnds = growUint32(partEnds, partWrite + 1);
        partEnds[partWrite++] = write;
        partStart = write;
      }
    };
    while (cursor < commands.length) {
      const command = commands[cursor++];
      const id = command & 7;
      const count = command >>> 3;
      if (id === 1 || id === 2) {
        if (id === 1) flush();
        xy = growInt32(xy, (write + count) * 2);
        for (let i = 0; i < count; i++) {
          x += zigZag(commands[cursor++] | 0);
          y += zigZag(commands[cursor++] | 0);
          xy[write * 2] = x;
          xy[write * 2 + 1] = y;
          write++;
        }
      } else if (id === 7) {
        if (write > partStart) {
          xy = growInt32(xy, (write + 1) * 2);
          xy[write * 2] = xy[partStart * 2];
          xy[write * 2 + 1] = xy[partStart * 2 + 1];
          write++;
        }
        flush();
      } else {
        break;
      }
    }
    flush();
    return { xy, write, partEnds, partWrite };
  }

  function tilePointToLngLat(
    x: number,
    y: number,
    extent: number,
    tile: Pick<VectorTileCoordinates, "x" | "y" | "z">
  ): GeoJSONPosition {
    const scale = 2 ** tile.z;
    const worldX = (tile.x + x / extent) / scale;
    const worldY = (tile.y + y / extent) / scale;
    const lng = worldX * 360 - 180;
    const n = Math.PI - 2 * Math.PI * worldY;
    const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return [lng, lat];
  }

  function decodePackedMVT(
    data: ArrayBuffer | Uint8Array,
    tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
    options: MVTDecodeOptions = {}
  ): PackedVectorTile {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const maxBytes = options.maxBytes ?? 2_097_152;
    const maxFeatures = options.maxFeatures ?? 16_384;
    const maxStringLength = options.maxStringLength ?? 8_192;
    const empty: PackedVectorTile = { x: tile.x, y: tile.y, z: tile.z, layers: [] };
    if (bytes.byteLength > maxBytes) return empty;
    const reader = new PbfReader(bytes, bytes.length, maxBytes, maxStringLength);
    const layerSpans: Array<{ start: number; end: number }> = [];
    while (!reader.done) {
      const { field, wire } = reader.tag();
      if (field === 3 && wire === 2) layerSpans.push(reader.readRange());
      else reader.skip(wire);
    }
    const allowed = options.layer ? new Set(Array.isArray(options.layer) ? options.layer : [options.layer]) : null;
    const layers: PackedMVTLayer[] = [];
    let remaining = maxFeatures;
    for (const span of layerSpans) {
      if (remaining <= 0) break;
      const layerReader = reader.fork(span.start, span.end);
      const nameParts: string[] = [];
      let extent = 4096;
      const keys: string[] = [];
      const values: PbfValue[] = [];
      const featureSpans: Array<{ start: number; end: number }> = [];
      while (!layerReader.done) {
        const { field, wire } = layerReader.tag();
        if (field === 1 && wire === 2) nameParts.push(layerReader.string());
        else if (field === 2 && wire === 2) featureSpans.push(layerReader.readRange());
        else if (field === 3 && wire === 2) keys.push(layerReader.string());
        else if (field === 4 && wire === 2) {
          const valueRange = layerReader.readRange();
          values.push(readValue(layerReader.fork(valueRange.start, valueRange.end)));
        } else if (field === 5 && wire === 0) extent = layerReader.varint();
        else layerReader.skip(wire);
      }
      const name = nameParts[0] || "";
      if (allowed && !allowed.has(name)) continue;

      let xy: Int32Array<ArrayBufferLike> = new Int32Array(Math.max(8, featureSpans.length * 4));
      let write = 0;
      let partEnds: Uint32Array<ArrayBufferLike> = new Uint32Array(Math.max(4, featureSpans.length));
      let partWrite = 0;
      const types: number[] = [];
      const ids: Array<string | number | undefined> = [];
      const vertexOffsets = [0];
      const partOffsets = [0];
      const tagOffsets = [0];
      let tags: Uint32Array<ArrayBufferLike> = new Uint32Array(Math.max(8, featureSpans.length * 2));
      let tagWrite = 0;

      for (const featureSpan of featureSpans) {
        if (remaining <= 0) break;
        const featureReader = reader.fork(featureSpan.start, featureSpan.end);
        let id: number | undefined;
        let type = 0;
        let geometry: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
        let featureTags: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
        while (!featureReader.done) {
          const { field, wire } = featureReader.tag();
          if (field === 1 && wire === 0) id = featureReader.varint();
          else if (field === 2 && wire === 2) featureTags = featureReader.packedVarints();
          else if (field === 3 && wire === 0) type = featureReader.varint();
          else if (field === 4 && wire === 2) geometry = featureReader.packedVarints();
          else featureReader.skip(wire);
        }
        const decoded = decodeGeometry(geometry, xy, write, partEnds, partWrite);
        xy = decoded.xy;
        write = decoded.write;
        partEnds = decoded.partEnds;
        partWrite = decoded.partWrite;
        if (write === vertexOffsets[vertexOffsets.length - 1]) continue;
        remaining--;
        types.push(type);
        ids.push(id);
        vertexOffsets.push(write);
        partOffsets.push(partWrite);
        tags = growUint32(tags, tagWrite + featureTags.length);
        tags.set(featureTags, tagWrite);
        tagWrite += featureTags.length;
        tagOffsets.push(tagWrite);
      }

      if (!types.length) continue;
      layers.push({
        name,
        extent,
        keys,
        values,
        xy: new Int32Array(xy.subarray(0, write * 2)),
        types: Uint8Array.from(types),
        ids,
        vertexOffsets: Uint32Array.from(vertexOffsets),
        partOffsets: Uint32Array.from(partOffsets),
        partEnds: new Uint32Array(partEnds.subarray(0, partWrite)),
        tagOffsets: Uint32Array.from(tagOffsets),
        tags: new Uint32Array(tags.subarray(0, tagWrite))
      });
    }
    return { x: tile.x, y: tile.y, z: tile.z, layers };
  }

  function packedToGeoJSON(packed: PackedVectorTile, options: MVTDecodeOptions = {}): GeoJSONFeature[] {
    const features: GeoJSONFeature[] = [];
    const tile = { x: packed.x, y: packed.y, z: packed.z };
    for (const layer of packed.layers) {
      const count = layer.types.length;
      for (let i = 0; i < count; i++) {
        const geometry = geometryOfFeature(layer, i, tile);
        if (!geometry) continue;
        const properties: Record<string, PbfValue> = { layer: layer.name };
        const tagStart = layer.tagOffsets[i];
        const tagEnd = layer.tagOffsets[i + 1];
        for (let t = tagStart; t + 1 < tagEnd; t += 2) {
          const key = layer.keys[layer.tags[t]];
          if (key) properties[key] = layer.values[layer.tags[t + 1]] ?? null;
        }
        const id = options.idProperty && properties[options.idProperty] != null
          ? properties[options.idProperty] as string | number
          : layer.ids[i];
        features.push({ type: "Feature", id, properties, geometry });
      }
    }
    return features;
  }

  function geometryOfFeature(
    layer: PackedMVTLayer,
    index: number,
    tile: Pick<VectorTileCoordinates, "x" | "y" | "z">
  ): GeoJSONGeometry | null {
    const vertexStart = layer.vertexOffsets[index];
    const vertexEnd = layer.vertexOffsets[index + 1];
    const partStart = layer.partOffsets[index];
    const partEnd = layer.partOffsets[index + 1];
    const type = layer.types[index];
    const lines: GeoJSONPosition[][] = [];
    let cursor = vertexStart;
    for (let p = partStart; p < partEnd; p++) {
      const end = layer.partEnds[p];
      const line: GeoJSONPosition[] = [];
      for (let v = cursor; v < end; v++) {
        line.push(tilePointToLngLat(layer.xy[v * 2], layer.xy[v * 2 + 1], layer.extent, tile));
      }
      if (line.length) lines.push(line);
      cursor = end;
    }
    if (cursor < vertexEnd) {
      const line: GeoJSONPosition[] = [];
      for (let v = cursor; v < vertexEnd; v++) {
        line.push(tilePointToLngLat(layer.xy[v * 2], layer.xy[v * 2 + 1], layer.extent, tile));
      }
      if (line.length) lines.push(line);
    }
    if (type === 1) {
      const points = lines.flat();
      if (!points.length) return null;
      if (points.length === 1) return { type: "Point", coordinates: points[0] };
      return { type: "MultiPoint", coordinates: points };
    }
    if (type === 2) {
      if (!lines.length) return null;
      if (lines.length === 1) return { type: "LineString", coordinates: lines[0] };
      return { type: "MultiLineString", coordinates: lines };
    }
    if (type === 3) {
      if (!lines.length) return null;
      if (lines.length === 1) return { type: "Polygon", coordinates: lines };
      return { type: "MultiPolygon", coordinates: [lines] };
    }
    return null;
  }

  return { decodePackedMVT, packedToGeoJSON };
}
