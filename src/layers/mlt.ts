/**
 * Orihon MLT subset 1 — columnar MapLibre Tile without FastPFOR / FSST / Morton.
 *
 * Tile = FeatureTable*
 * FeatureTable:
 *   varint metadataSize, varint dataSize
 *   metadata: version=1, name, extent, featureCount, columnCount, columns{kind,name}
 *   data: per column, varint streamCount then streams
 *     {physical, logical, encoding, numValues, byteLength, payload}
 *
 * Column kinds: 1 id · 2 geometry · 3 string · 4 sint · 5 float64 · 6 bool
 * Geometry streams (plain/varint only):
 *   GeometryType (MLT 0–5), NumParts (parts/feature), NumRings (verts/part), VertexBuffer
 * Geometry types: 0 Point, 1 LineString, 2 Polygon, 3 MultiPoint, 4 MultiLineString, 5 MultiPolygon
 * MVT 1/2/3 maps to those (Multi* when a feature has more than one part or point).
 */

import { packedToGeoJSON, registerPackedTileSniffer, type MVTDecodeOptions, type PackedMVTLayer, type PackedVectorTile } from "./mvt.js";
import type { VectorTileCoordinates, VectorTileProvider } from "./vector-tile-layer.js";

const VERSION = 1;
const KIND_ID = 1;
const KIND_GEOMETRY = 2;
const KIND_STRING = 3;
const KIND_SINT = 4;
const KIND_FLOAT = 5;
const KIND_BOOL = 6;

const PHYS_DATA = 0;
const PHYS_LENGTH = 1;
const LOG_NONE = 0;
const LOG_VERTEX = 1;
const LOG_PARTS = 3;
const LOG_RINGS = 4;
const ENC_PLAIN = 0;
const ENC_VARINT = 1;
const ENC_I32LE = 3;

type PbfValue = string | number | boolean | null;

export function encodePackedMLT(packed: PackedVectorTile): Uint8Array {
  const out = new ByteWriter();
  for (const layer of packed.layers) {
    const { metadata, data } = encodeLayer(layer);
    out.varint(metadata.length);
    out.varint(data.length);
    out.bytes(metadata);
    out.bytes(data);
  }
  return out.take();
}

export function decodePackedMLT(
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions = {}
): PackedVectorTile {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const maxBytes = options.maxBytes ?? 2_097_152;
  const maxFeatures = options.maxFeatures ?? 16_384;
  const empty: PackedVectorTile = { x: tile.x, y: tile.y, z: tile.z, layers: [] };
  if (bytes.byteLength > maxBytes) return empty;
  const reader = new ByteReader(bytes);
  const allowed = options.layer ? new Set(Array.isArray(options.layer) ? options.layer : [options.layer]) : null;
  const layers: PackedMVTLayer[] = [];
  let remaining = maxFeatures;
  while (!reader.done && remaining > 0) {
    const metadataSize = reader.varint();
    const dataSize = reader.varint();
    const metadata = reader.slice(metadataSize);
    const body = reader.slice(dataSize);
    const layer = decodeLayer(metadata, body, remaining, options.maxStringLength ?? 8_192);
    if (!layer) continue;
    if (allowed && !allowed.has(layer.name)) continue;
    if (layer.types.length > remaining) trimLayer(layer, remaining);
    remaining -= layer.types.length;
    if (layer.types.length) layers.push(layer);
  }
  return { x: tile.x, y: tile.y, z: tile.z, layers };
}

/** True when the buffer is Orihon MLT subset 1 (not Mapbox MVT). */
export function looksLikeMLT(data: ArrayBuffer | Uint8Array): boolean {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 8) return false;
  const reader = new ByteReader(bytes);
  const metadataSize = reader.varint();
  const dataSize = reader.varint();
  if (metadataSize < 3 || metadataSize > bytes.length) return false;
  if (reader.pos + metadataSize + dataSize > bytes.length) return false;
  const meta = new ByteReader(bytes, reader.pos, reader.pos + metadataSize);
  return meta.varint() === VERSION;
}

/** `decodePackedMVT` hook: returns a packed tile or null when the buffer is not MLT. */
export function sniffPackedMLT(
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions = {}
): PackedVectorTile | null {
  if (!looksLikeMLT(data)) return null;
  return decodePackedMLT(data, tile, options);
}

registerPackedTileSniffer(sniffPackedMLT);

export function decodeMLT(
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions = {}
) {
  return packedToGeoJSON(decodePackedMLT(data, tile, options), options);
}

export function createMLTProvider(
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
    if (!response.ok) throw new Error(`MLT request failed: ${response.status}`);
    return decodeMLT(await response.arrayBuffer(), tile, options);
  };
}

function encodeLayer(layer: PackedMVTLayer): { metadata: Uint8Array; data: Uint8Array } {
  const count = layer.types.length;
  const propCols = propertyColumns(layer);
  const columns: Array<{ kind: number; name: string }> = [{ kind: KIND_GEOMETRY, name: "geometry" }];
  const hasId = layer.ids.some((id) => id != null);
  const idsKind = hasId ? idKind(layer.ids) : KIND_SINT;
  if (hasId) columns.push({ kind: KIND_ID, name: "id" });
  for (const col of propCols) columns.push({ kind: col.kind, name: col.name });

  const meta = new ByteWriter();
  meta.varint(VERSION);
  meta.string(layer.name);
  meta.varint(layer.extent);
  meta.varint(count);
  meta.varint(columns.length);
  for (const col of columns) {
    meta.varint(col.kind);
    meta.string(col.name);
  }

  const data = new ByteWriter();
  writeGeometryColumn(data, layer);
  if (hasId) writeIdColumn(data, layer.ids, idsKind);
  for (const col of propCols) writePropertyColumn(data, col);

  return { metadata: meta.take(), data: data.take() };
}

function writeGeometryColumn(out: ByteWriter, layer: PackedMVTLayer): void {
  const types: number[] = [];
  const numParts: number[] = [];
  const numRings: number[] = [];
  const count = layer.types.length;
  for (let i = 0; i < count; i++) {
    const partStart = layer.partOffsets[i];
    const partEnd = layer.partOffsets[i + 1];
    const vertexStart = layer.vertexOffsets[i];
    const vertexEnd = layer.vertexOffsets[i + 1];
    const parts = Math.max(1, partEnd - partStart);
    types.push(mvtToMlt(layer.types[i], vertexEnd - vertexStart, parts));
    numParts.push(parts);
    let cursor = vertexStart;
    if (partEnd > partStart) {
      for (let p = partStart; p < partEnd; p++) {
        const end = layer.partEnds[p];
        numRings.push(Math.max(0, end - cursor));
        cursor = end;
      }
    } else {
      numRings.push(Math.max(0, vertexEnd - vertexStart));
    }
  }

  const typeBytes = Uint8Array.from(types);
  const partsPayload = encodeVarints(numParts);
  const ringsPayload = encodeVarints(numRings);
  const vertexPayload = encodeI32le(layer.xy);

  out.varint(4);
  writeStream(out, PHYS_DATA, LOG_NONE, ENC_PLAIN, types.length, typeBytes);
  writeStream(out, PHYS_LENGTH, LOG_PARTS, ENC_VARINT, numParts.length, partsPayload);
  writeStream(out, PHYS_LENGTH, LOG_RINGS, ENC_VARINT, numRings.length, ringsPayload);
  writeStream(out, PHYS_DATA, LOG_VERTEX, ENC_I32LE, layer.xy.length, vertexPayload);
}

function writeIdColumn(out: ByteWriter, ids: Array<string | number | undefined>, kind: number): void {
  out.varint(1);
  if (kind === KIND_STRING) {
    const payload = encodeStrings(ids.map((id) => id == null ? "" : String(id)));
    writeStream(out, PHYS_DATA, LOG_NONE, ENC_PLAIN, ids.length, payload);
    return;
  }
  const values = ids.map((id) => typeof id === "number" && Number.isFinite(id) ? id : 0);
  writeStream(out, PHYS_DATA, LOG_NONE, ENC_VARINT, values.length, encodeZigZagVarints(values));
}

function writePropertyColumn(out: ByteWriter, col: PropColumn): void {
  out.varint(1);
  if (col.kind === KIND_STRING) writeStream(out, PHYS_DATA, LOG_NONE, ENC_PLAIN, col.values.length, encodeStrings(col.values.map((v) => v == null ? "" : String(v))));
  else if (col.kind === KIND_BOOL) writeStream(out, PHYS_DATA, LOG_NONE, ENC_PLAIN, col.values.length, Uint8Array.from(col.values.map((v) => v ? 1 : 0)));
  else if (col.kind === KIND_FLOAT) writeStream(out, PHYS_DATA, LOG_NONE, ENC_PLAIN, col.values.length, encodeF64le(col.values.map((v) => Number(v) || 0)));
  else writeStream(out, PHYS_DATA, LOG_NONE, ENC_VARINT, col.values.length, encodeZigZagVarints(col.values.map((v) => Number(v) || 0)));
}

function writeStream(
  out: ByteWriter,
  physical: number,
  logical: number,
  encoding: number,
  numValues: number,
  payload: Uint8Array
): void {
  out.varint(physical);
  out.varint(logical);
  out.varint(encoding);
  out.varint(numValues);
  out.varint(payload.length);
  out.bytes(payload);
}

function decodeLayer(metadata: Uint8Array, body: Uint8Array, maxFeatures: number, maxString: number): PackedMVTLayer | null {
  const meta = new ByteReader(metadata);
  if (meta.varint() !== VERSION) return null;
  const name = meta.string(maxString);
  const extent = meta.varint() || 4096;
  const featureCount = Math.min(meta.varint(), maxFeatures);
  const columnCount = meta.varint();
  const columns: Array<{ kind: number; name: string }> = [];
  for (let i = 0; i < columnCount; i++) {
    columns.push({ kind: meta.varint(), name: meta.string(maxString) });
  }
  const data = new ByteReader(body);
  let types: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let numParts: number[] = [];
  let numRings: number[] = [];
  let xy: Int32Array<ArrayBufferLike> = new Int32Array(0);
  const ids: Array<string | number | undefined> = Array.from({ length: featureCount });
  const keys: string[] = [];
  const valueColumns: PbfValue[][] = [];

  for (const column of columns) {
    const streamCount = data.varint();
    const streams: Stream[] = [];
    for (let s = 0; s < streamCount; s++) streams.push(readStream(data));
    if (column.kind === KIND_GEOMETRY) {
      for (const stream of streams) {
        if (stream.physical === PHYS_DATA && stream.logical === LOG_NONE) types = stream.payload.subarray(0, featureCount);
        else if (stream.physical === PHYS_LENGTH && stream.logical === LOG_PARTS) numParts = decodeVarints(stream.payload, stream.numValues);
        else if (stream.physical === PHYS_LENGTH && stream.logical === LOG_RINGS) numRings = decodeVarints(stream.payload, stream.numValues);
        else if (stream.physical === PHYS_DATA && stream.logical === LOG_VERTEX) {
          xy = stream.encoding === ENC_I32LE ? decodeI32le(stream.payload) : decodeZigZagVarintsToI32(stream.payload, stream.numValues);
        }
      }
    } else if (column.kind === KIND_ID) {
      const stream = streams[0];
      if (!stream) continue;
      if (stream.encoding === ENC_PLAIN) {
        const strings = decodeStrings(stream.payload, featureCount, maxString);
        for (let i = 0; i < featureCount; i++) ids[i] = strings[i] || undefined;
      } else {
        const numbers = decodeZigZagVarints(stream.payload, featureCount);
        for (let i = 0; i < featureCount; i++) ids[i] = numbers[i];
      }
    } else {
      keys.push(column.name);
      const stream = streams[0];
      valueColumns.push(decodePropertyStream(column.kind, stream, featureCount, maxString));
    }
  }

  if (!types.length) return null;
  const count = Math.min(featureCount, types.length);
  const vertexOffsets = [0];
  const partOffsets = [0];
  const partEnds: number[] = [];
  let vert = 0;
  let part = 0;
  for (let i = 0; i < count; i++) {
    const parts = Math.max(1, numParts[i] || 1);
    for (let p = 0; p < parts; p++) {
      vert += Math.max(0, numRings[part++] || 0);
      partEnds.push(vert);
    }
    vertexOffsets.push(vert);
    partOffsets.push(partEnds.length);
  }

  const mvtTypes = new Uint8Array(count);
  for (let i = 0; i < count; i++) mvtTypes[i] = mltToMvt(types[i]);

  const values: PbfValue[] = [];
  const tags: number[] = [];
  const tagOffsets = [0];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < keys.length; k++) {
      const value = valueColumns[k][i];
      if (value == null || value === "") continue;
      tags.push(k, values.length);
      values.push(value);
    }
    tagOffsets.push(tags.length);
  }

  return {
    name,
    extent,
    keys,
    values,
    xy: xy.length >= vert * 2 ? xy.subarray(0, vert * 2) : xy,
    types: mvtTypes,
    ids: ids.slice(0, count),
    vertexOffsets: Uint32Array.from(vertexOffsets),
    partOffsets: Uint32Array.from(partOffsets),
    partEnds: Uint32Array.from(partEnds),
    tagOffsets: Uint32Array.from(tagOffsets),
    tags: Uint32Array.from(tags)
  };
}

interface Stream {
  physical: number;
  logical: number;
  encoding: number;
  numValues: number;
  payload: Uint8Array;
}

function readStream(reader: ByteReader): Stream {
  const physical = reader.varint();
  const logical = reader.varint();
  const encoding = reader.varint();
  const numValues = reader.varint();
  const byteLength = reader.varint();
  return { physical, logical, encoding, numValues, payload: reader.slice(byteLength) };
}

function decodePropertyStream(kind: number, stream: Stream | undefined, count: number, maxString: number): PbfValue[] {
  const values: PbfValue[] = Array.from({ length: count }, () => null);
  if (!stream) return values;
  if (kind === KIND_STRING) {
    const strings = decodeStrings(stream.payload, count, maxString);
    for (let i = 0; i < count; i++) values[i] = strings[i] === "" ? null : strings[i];
  } else if (kind === KIND_BOOL) {
    for (let i = 0; i < count && i < stream.payload.length; i++) values[i] = Boolean(stream.payload[i]);
  } else if (kind === KIND_FLOAT) {
    const numbers = decodeF64le(stream.payload, count);
    for (let i = 0; i < count; i++) values[i] = numbers[i];
  } else {
    const numbers = decodeZigZagVarints(stream.payload, count);
    for (let i = 0; i < count; i++) values[i] = numbers[i];
  }
  return values;
}

interface PropColumn {
  kind: number;
  name: string;
  values: PbfValue[];
}

function propertyColumns(layer: PackedMVTLayer): PropColumn[] {
  const count = layer.types.length;
  return layer.keys.map((name, keyIndex) => {
    const values: PbfValue[] = Array.from({ length: count }, () => null);
    for (let i = 0; i < count; i++) {
      const start = layer.tagOffsets[i];
      const end = layer.tagOffsets[i + 1];
      for (let t = start; t + 1 < end; t += 2) {
        if (layer.tags[t] === keyIndex) values[i] = layer.values[layer.tags[t + 1]] ?? null;
      }
    }
    return { kind: inferKind(values), name, values };
  });
}

function inferKind(values: PbfValue[]): number {
  let sawBool = false;
  let sawInt = false;
  let sawFloat = false;
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === "boolean") sawBool = true;
    else if (typeof value === "number") {
      if (Number.isInteger(value)) sawInt = true;
      else sawFloat = true;
    } else return KIND_STRING;
  }
  if (sawFloat) return KIND_FLOAT;
  if (sawInt && !sawBool) return KIND_SINT;
  if (sawBool && !sawInt) return KIND_BOOL;
  if (sawBool || sawInt) return KIND_STRING;
  return KIND_STRING;
}

function idKind(ids: Array<string | number | undefined>): number {
  return ids.every((id) => id == null || (typeof id === "number" && Number.isInteger(id))) ? KIND_SINT : KIND_STRING;
}

function mvtToMlt(mvtType: number, vertices: number, parts: number): number {
  if (mvtType === 1) return vertices > 1 ? 3 : 0;
  if (mvtType === 2) return parts > 1 ? 4 : 1;
  if (mvtType === 3) return parts > 1 ? 5 : 2;
  return 0;
}

function mltToMvt(mltType: number): number {
  if (mltType === 0 || mltType === 3) return 1;
  if (mltType === 1 || mltType === 4) return 2;
  if (mltType === 2 || mltType === 5) return 3;
  return 1;
}

function trimLayer(layer: PackedMVTLayer, max: number): void {
  layer.types = layer.types.subarray(0, max);
  layer.ids.length = max;
  layer.vertexOffsets = layer.vertexOffsets.subarray(0, max + 1);
  layer.partOffsets = layer.partOffsets.subarray(0, max + 1);
  const parts = layer.partOffsets[max];
  layer.partEnds = layer.partEnds.subarray(0, parts);
  const verts = layer.vertexOffsets[max];
  layer.xy = layer.xy.subarray(0, verts * 2);
  layer.tagOffsets = layer.tagOffsets.subarray(0, max + 1);
  layer.tags = layer.tags.subarray(0, layer.tagOffsets[max]);
}

class ByteWriter {
  private buf = new Uint8Array(256);
  length = 0;

  varint(value: number): void {
    let next = Math.max(0, value >>> 0);
    while (next > 0x7f) {
      this.u8((next & 0x7f) | 0x80);
      next >>>= 7;
    }
    this.u8(next);
  }

  string(value: string): void {
    const bytes = textEncoder.encode(value);
    this.varint(bytes.length);
    this.bytes(bytes);
  }

  bytes(src: Uint8Array): void {
    this.#need(src.length);
    this.buf.set(src, this.length);
    this.length += src.length;
  }

  take(): Uint8Array {
    return this.buf.slice(0, this.length);
  }

  private u8(value: number): void {
    this.#need(1);
    this.buf[this.length++] = value;
  }

  #need(extra: number): void {
    if (this.length + extra <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.length + extra, this.buf.length * 2));
    next.set(this.buf);
    this.buf = next;
  }
}

class ByteReader {
  constructor(readonly bytes: Uint8Array, public pos = 0, readonly end = bytes.length) {}

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    while (this.pos < this.end) {
      const byte = this.bytes[this.pos++];
      result += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) break;
      shift += 7;
    }
    return result;
  }

  string(maxString: number): string {
    const length = this.varint();
    const slice = this.slice(length);
    if (slice.length > maxString) return "";
    return textDecoder.decode(slice);
  }

  slice(length: number): Uint8Array {
    const start = this.pos;
    const end = Math.min(this.end, start + Math.max(0, length));
    this.pos = end;
    return this.bytes.subarray(start, end);
  }
}

function encodeVarints(values: number[]): Uint8Array {
  const out = new ByteWriter();
  for (const value of values) out.varint(value >>> 0);
  return out.take();
}

function encodeZigZagVarints(values: number[]): Uint8Array {
  const out = new ByteWriter();
  for (const value of values) out.varint(zigZagEncode(value | 0));
  return out.take();
}

function encodeI32le(values: Int32Array): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) view.setInt32(i * 4, values[i], true);
  return out;
}

function encodeF64le(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 8);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat64(i * 8, values[i], true);
  return out;
}

function encodeStrings(values: string[]): Uint8Array {
  const out = new ByteWriter();
  for (const value of values) out.string(value);
  return out.take();
}

function decodeVarints(bytes: Uint8Array, count: number): number[] {
  const reader = new ByteReader(bytes);
  const values: number[] = [];
  while (!reader.done && values.length < count) values.push(reader.varint());
  return values;
}

function decodeZigZagVarints(bytes: Uint8Array, count: number): number[] {
  return decodeVarints(bytes, count).map(zigZagDecode);
}

function decodeZigZagVarintsToI32(bytes: Uint8Array, count: number): Int32Array {
  const values = decodeZigZagVarints(bytes, count);
  return Int32Array.from(values);
}

function decodeI32le(bytes: Uint8Array): Int32Array {
  const count = bytes.length >> 2;
  const values = new Int32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) values[i] = view.getInt32(i * 4, true);
  return values;
}

function decodeF64le(bytes: Uint8Array, count: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let i = 0; i < count && (i + 1) * 8 <= bytes.length; i++) values.push(view.getFloat64(i * 8, true));
  return values;
}

function decodeStrings(bytes: Uint8Array, count: number, maxString: number): string[] {
  const reader = new ByteReader(bytes);
  const values: string[] = [];
  while (!reader.done && values.length < count) values.push(reader.string(maxString));
  while (values.length < count) values.push("");
  return values;
}

function zigZagEncode(value: number): number {
  return (value << 1) ^ (value >> 31);
}

function zigZagDecode(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
