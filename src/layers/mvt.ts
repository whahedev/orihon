import type { GeoJSONFeature, GeoJSONGeometry, GeoJSONPosition } from "./geojson.js";
import type { VectorTileCoordinates, VectorTileProvider } from "./vector-tile-layer.js";

type PbfValue = string | number | boolean | null;

interface MVTLayer {
  name: string;
  extent: number;
  keys: string[];
  values: PbfValue[];
  features: Uint8Array[];
}

interface RawMVTFeature {
  id?: string | number;
  tags: number[];
  type: number;
  geometry: number[];
}

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

export function decodeMVT(data: ArrayBuffer | Uint8Array, tile: Pick<VectorTileCoordinates, "x" | "y" | "z">, options: MVTDecodeOptions = {}): GeoJSONFeature[] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const maxBytes = options.maxBytes ?? 2_097_152;
  const maxFeatures = options.maxFeatures ?? 16_384;
  const maxStringLength = options.maxStringLength ?? 8_192;
  if (bytes.byteLength > maxBytes) return [];
  const reader = new PbfReader(bytes, maxBytes, maxStringLength);
  const layers: MVTLayer[] = [];
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 3 && wire === 2) layers.push(readLayer(reader.fork(reader.readBytes())));
    else reader.skip(wire);
  }
  const allowed = options.layer ? new Set(Array.isArray(options.layer) ? options.layer : [options.layer]) : null;
  const features: GeoJSONFeature[] = [];
  for (const layer of layers) {
    if (allowed && !allowed.has(layer.name)) continue;
    for (const rawBytes of layer.features) {
      if (features.length >= maxFeatures) return features;
      const raw = readFeature(reader.fork(rawBytes));
      const geometry = decodeGeometry(raw.geometry, raw.type, layer.extent, tile);
      if (!geometry) continue;
      const properties = readProperties(raw.tags, layer);
      properties.layer = properties.layer ?? layer.name;
      const id = options.idProperty && properties[options.idProperty] != null
        ? properties[options.idProperty] as string | number
        : raw.id;
      features.push({ type: "Feature", id, properties, geometry });
    }
  }
  return features;
}

export function createMVTProvider(urlTemplate: string | ((tile: VectorTileCoordinates) => string), options: MVTDecodeOptions = {}): VectorTileProvider {
  return async (tile) => {
    const url = typeof urlTemplate === "function"
      ? urlTemplate(tile)
      : urlTemplate
        .replaceAll("{x}", String(tile.x))
        .replaceAll("{y}", String(tile.y))
        .replaceAll("{z}", String(tile.z));
    const response = await fetch(url, { signal: tile.signal });
    if (!response.ok) throw new Error(`MVT request failed: ${response.status}`);
    return decodeMVT(await response.arrayBuffer(), tile, options);
  };
}

function readLayer(reader: PbfReader): MVTLayer {
  const layer: MVTLayer = { name: "", extent: 4096, keys: [], values: [], features: [] };
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) layer.name = reader.string();
    else if (field === 2 && wire === 2) layer.features.push(reader.readBytes());
    else if (field === 3 && wire === 2) layer.keys.push(reader.string());
    else if (field === 4 && wire === 2) layer.values.push(readValue(reader.fork(reader.readBytes())));
    else if (field === 5 && wire === 0) layer.extent = reader.varint();
    else reader.skip(wire);
  }
  return layer;
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

function readFeature(reader: PbfReader): RawMVTFeature {
  const feature: RawMVTFeature = { tags: [], type: 0, geometry: [] };
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 0) feature.id = reader.varint();
    else if (field === 2 && wire === 2) feature.tags = reader.packedVarints();
    else if (field === 3 && wire === 0) feature.type = reader.varint();
    else if (field === 4 && wire === 2) feature.geometry = reader.packedVarints();
    else reader.skip(wire);
  }
  return feature;
}

function readProperties(tags: number[], layer: MVTLayer): Record<string, PbfValue> {
  const properties: Record<string, PbfValue> = {};
  for (let index = 0; index < tags.length - 1; index += 2) {
    const key = layer.keys[tags[index]];
    if (key) properties[key] = layer.values[tags[index + 1]] ?? null;
  }
  return properties;
}

function decodeGeometry(commands: number[], type: number, extent: number, tile: Pick<VectorTileCoordinates, "x" | "y" | "z">): GeoJSONGeometry | null {
  let cursor = 0;
  let x = 0;
  let y = 0;
  let line: GeoJSONPosition[] = [];
  const lines: GeoJSONPosition[][] = [];
  const flush = (): void => {
    if (line.length) lines.push(line);
    line = [];
  };
  while (cursor < commands.length) {
    const command = commands[cursor++];
    const id = command & 0x7;
    const count = command >> 3;
    if (id === 1 || id === 2) {
      if (id === 1) flush();
      for (let i = 0; i < count; i++) {
        x += zigZag(commands[cursor++]);
        y += zigZag(commands[cursor++]);
        line.push(tilePointToLngLat(x, y, extent, tile));
      }
    } else if (id === 7) {
      if (line.length) line.push(line[0]);
      flush();
    } else {
      break;
    }
  }
  flush();
  if (type === 1) {
    const points = lines.flat();
    if (points.length === 1) return { type: "Point", coordinates: points[0] };
    return { type: "MultiPoint", coordinates: points };
  }
  if (type === 2) {
    if (lines.length === 1) return { type: "LineString", coordinates: lines[0] };
    return { type: "MultiLineString", coordinates: lines };
  }
  if (type === 3) {
    if (lines.length === 1) return { type: "Polygon", coordinates: lines };
    return { type: "MultiPolygon", coordinates: [lines] };
  }
  return null;
}

function tilePointToLngLat(x: number, y: number, extent: number, tile: Pick<VectorTileCoordinates, "x" | "y" | "z">): GeoJSONPosition {
  const scale = 2 ** tile.z;
  const worldX = (tile.x + x / extent) / scale;
  const worldY = (tile.y + y / extent) / scale;
  const lng = worldX * 360 - 180;
  const n = Math.PI - 2 * Math.PI * worldY;
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lng, lat];
}

function zigZag(value: number): number {
  return (value >> 1) ^ (-(value & 1));
}

class PbfReader {
  position = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly maxLength = 2_097_152,
    readonly maxString = 8_192
  ) {}
  get done(): boolean { return this.position >= this.bytes.length; }
  fork(bytes: Uint8Array): PbfReader {
    return new PbfReader(bytes, this.maxLength, this.maxString);
  }
  tag(): { field: number; wire: number } {
    const value = this.varint();
    return { field: value >> 3, wire: value & 0x7 };
  }
  varint(): number {
    let result = 0;
    let shift = 0;
    while (this.position < this.bytes.length) {
      const byte = this.bytes[this.position++];
      result += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) break;
      shift += 7;
    }
    return result;
  }
  svarint(): number { return zigZag(this.varint()); }
  readBytes(): Uint8Array {
    const length = this.varint();
    if (length < 0 || length > this.maxLength || this.position + length > this.bytes.length) {
      this.position = this.bytes.length;
      return this.bytes.subarray(0, 0);
    }
    const start = this.position;
    this.position += length;
    return this.bytes.slice(start, start + length);
  }
  packedVarints(): number[] {
    const child = this.fork(this.readBytes());
    const result: number[] = [];
    while (!child.done) result.push(child.varint());
    return result;
  }
  string(): string {
    const bytes = this.readBytes();
    if (bytes.length > this.maxString) return "";
    return new TextDecoder().decode(bytes);
  }
  float(): number {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.position, 4);
    const value = view.getFloat32(0, true);
    this.position += 4;
    return value;
  }
  double(): number {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.position, 8);
    const value = view.getFloat64(0, true);
    this.position += 8;
    return value;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.position += 8;
    else if (wire === 2) this.position += this.varint();
    else if (wire === 5) this.position += 4;
    else this.position = this.bytes.length;
  }
}
