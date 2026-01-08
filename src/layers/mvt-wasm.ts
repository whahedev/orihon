/**
 * Optional WASM MVT geometry decoder (`orihon/mvt-wasm`).
 * JS still walks PBF layers; WASM turns command+zigzag varints into xy + partEnds.
 * Falls back to JS `decodePackedMVTJs` when WebAssembly is missing or the module rejects a tile.
 * Importing this module registers the decoder on `decodePackedMVT` / `createMVTProvider`.
 */

import {
  decodePackedMVTJs,
  packedMvtInternals,
  packedToGeoJSON,
  registerPackedMvtWasm,
  type MVTDecodeOptions,
  type PackedMVTLayer,
  type PackedVectorTile
} from "./mvt.js";
import type { VectorTileCoordinates, VectorTileProvider } from "./vector-tile-layer.js";
import { decodePackedMVTTileWasm, mvtTileWasmError, mvtTileWasmSupported } from "./mvt-tile-wasm.js";
import { alignWasm4, growWasmMemory } from "../services/wasm-utils.js";
export { mvtTileWasmError, mvtTileWasmSupported };

type PbfValue = string | number | boolean | null;

const { PbfReader, readValue, growInt32, growUint32 } = packedMvtInternals;

interface WasmGeom {
  decode: (inPtr: number, inEnd: number, xyPtr: number, xyEnd: number, partsPtr: number, partsEnd: number) => number;
  memory: WebAssembly.Memory;
}

let wasmGeom: WasmGeom | null | undefined;
let wasmError = "";

export function mvtGeometryWasmSupported(): boolean {
  return Boolean(loadWasm());
}

export function mvtGeometryWasmError(): string {
  loadWasm();
  return wasmError;
}

export function decodeMvtGeometryWasm(bytes: Uint8Array): { xy: Int32Array; partEnds: Uint32Array } | null {
  const wasm = loadWasm();
  if (!wasm) return null;
  const decoded = wasmDecode(wasm, bytes);
  return decoded;
}

export function decodePackedMVTFeatureWasm(
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions = {}
): PackedVectorTile {
  const wasm = loadWasm();
  if (!wasm) return decodePackedMVTJs(data, tile, options);
  try {
    return decodePackedWithWasm(wasm, data, tile, options);
  } catch {
    return decodePackedMVTJs(data, tile, options);
  }
}

export function decodePackedMVTWasm(
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions = {}
): PackedVectorTile {
  const tilePacked = decodePackedMVTTileWasm(data, tile, options);
  if (tilePacked) return tilePacked;
  return decodePackedMVTFeatureWasm(data, tile, options);
}

export function createMVTWasmProvider(
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
    const packed = decodePackedMVTWasm(await response.arrayBuffer(), tile, options);
    return packedToGeoJSON(packed, options);
  };
}

if (mvtTileWasmSupported() || mvtGeometryWasmSupported()) registerPackedMvtWasm(decodePackedMVTWasm);

function loadWasm(): WasmGeom | null {
  if (wasmGeom !== undefined) return wasmGeom;
  wasmGeom = null;
  if (typeof WebAssembly === "undefined") {
    wasmError = "WebAssembly is unavailable";
    return null;
  }
  try {
    const bytes = mvtGeometryWasmBytes();
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {});
    const exported = instance.exports as {
      d: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
      m: WebAssembly.Memory;
    };
    if (typeof exported.d !== "function" || !exported.m) {
      wasmError = "WASM exports missing";
      return null;
    }
    wasmGeom = { decode: exported.d, memory: exported.m };
    return wasmGeom;
  } catch (error) {
    wasmError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

function wasmDecode(wasm: WasmGeom, bytes: Uint8Array): { xy: Int32Array; partEnds: Uint32Array } | null {
  const inputPtr = 16;
  const xyCap = 16_384 * 8;
  const partsCap = 4_096 * 4;
  const xyPtr = alignWasm4(inputPtr + bytes.length + 8);
  const partsPtr = xyPtr + xyCap;
  const need = partsPtr + partsCap + 16;
  growWasmMemory(wasm.memory, need);
  const heap = new Uint8Array(wasm.memory.buffer);
  heap.set(bytes, inputPtr);
  const code = wasm.decode(inputPtr, inputPtr + bytes.length, xyPtr, xyPtr + xyCap, partsPtr, partsPtr + partsCap);
  if (code !== 0) return null;
  const view = new DataView(wasm.memory.buffer);
  const verts = view.getInt32(0, true);
  const parts = view.getInt32(4, true);
  if (verts < 0 || parts < 0) return null;
  const xy = Int32Array.from(new Int32Array(wasm.memory.buffer, xyPtr, verts * 2));
  const partEnds = Uint32Array.from(new Uint32Array(wasm.memory.buffer, partsPtr, parts));
  return { xy, partEnds };
}

function decodePackedWithWasm(
  wasm: WasmGeom,
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions
): PackedVectorTile {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const maxBytes = options.maxBytes ?? 2_097_152;
  const maxFeatures = options.maxFeatures ?? 16_384;
  const maxString = options.maxStringLength ?? 8_192;
  const empty: PackedVectorTile = { x: tile.x, y: tile.y, z: tile.z, layers: [] };
  if (bytes.byteLength > maxBytes) return empty;
  const reader = new PbfReader(bytes, bytes.length, maxBytes, maxString);
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
      let geomStart = 0;
      let geomEnd = 0;
      let featureTags: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
      while (!featureReader.done) {
        const { field, wire } = featureReader.tag();
        if (field === 1 && wire === 0) id = featureReader.varint();
        else if (field === 2 && wire === 2) featureTags = featureReader.packedVarints();
        else if (field === 3 && wire === 0) type = featureReader.varint();
        else if (field === 4 && wire === 2) {
          const range = featureReader.readRange();
          geomStart = range.start;
          geomEnd = range.end;
        } else featureReader.skip(wire);
      }
      const geom = wasmDecode(wasm, bytes.subarray(geomStart, geomEnd));
      if (!geom) throw new Error("wasm geometry");
      xy = growInt32(xy, (write + geom.xy.length / 2) * 2);
      xy.set(geom.xy, write * 2);
      partEnds = growUint32(partEnds, partWrite + geom.partEnds.length);
      for (let p = 0; p < geom.partEnds.length; p++) partEnds[partWrite + p] = write + geom.partEnds[p];
      write += geom.xy.length / 2;
      partWrite += geom.partEnds.length;
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

function i32const(value: number): number[] {
  const out = [0x41];
  let next = value | 0;
  while (true) {
    const byte = next & 0x7f;
    next >>= 7;
    if ((next === 0 && (byte & 0x40) === 0) || (next === -1 && (byte & 0x40) !== 0)) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

function leb(value: number): number[] {
  const out: number[] = [];
  let next = value >>> 0;
  while (next > 0x7f) {
    out.push((next & 0x7f) | 0x80);
    next >>>= 7;
  }
  out.push(next);
  return out;
}

function section(id: number, body: number[]): number[] {
  return [id, ...leb(body.length), ...body];
}

function mvtGeometryWasmBytes(): Uint8Array<ArrayBuffer> {
  const code = wasmDecodeFunction();
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [0x01, 0x60, 0x06, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f]),
    ...section(3, [0x01, 0x00]),
    ...section(5, [0x01, 0x00, 0x01]),
    ...section(7, [
      0x02,
      0x01, 0x64, 0x00, 0x00,
      0x01, 0x6d, 0x02, 0x00
    ]),
    ...section(10, [...leb(1), ...leb(code.length), ...code])
  ];
  return Uint8Array.from(bytes);
}

/**
 * decode(in, inEnd, xy, xyEnd, parts, partsEnd) -> 0 | -1
 * Writes vertexCount at mem[0], partCount at mem[4].
 */
function wasmDecodeFunction(): number[] {
  const VOID = 0x40;
  const GET = 0x20;
  const SET = 0x21;
  const TEE = 0x22;
  const ADD = 0x6a;
  const SUB = 0x6b;
  const MUL = 0x6c;
  const AND = 0x71;
  const OR = 0x72;
  const XOR = 0x73;
  const SHL = 0x74;
  const SHR_U = 0x76;
  const EQ = 0x46;
  const GE_U = 0x4f;
  const GT_U = 0x4b;
  const LT_U = 0x49;
  const IF = 0x04;
  const ELSE = 0x05;
  const END = 0x0b;
  const BLOCK = 0x02;
  const LOOP = 0x03;
  const BR = 0x0c;
  const BR_IF = 0x0d;
  const RET = 0x0f;
  const LOAD8 = [0x2d, 0x00, 0x00];
  const LOAD = [0x28, 0x02, 0x00];
  const STORE = [0x36, 0x02, 0x00];

  const IN = 0;
  const IN_END = 1;
  const XY = 2;
  const XY_END = 3;
  const PARTS = 4;
  const PARTS_END = 5;
  const POS = 6;
  const X = 7;
  const Y = 8;
  const WRITE = 9;
  const PART_START = 10;
  const PART_WRITE = 11;
  const VAL = 12;
  const SHIFT = 13;
  const BYTE = 14;
  const ID = 15;
  const COUNT = 16;
  const I = 17;

  const C = i32const;
  const fail = [...C(-1), RET];
  const readVarint = [
    ...C(0), SET, VAL,
    ...C(0), SET, SHIFT,
    BLOCK, VOID,
    LOOP, VOID,
    GET, POS, GET, IN_END, GE_U, IF, VOID, ...fail, END,
    GET, POS, ...LOAD8, SET, BYTE,
    GET, POS, ...C(1), ADD, SET, POS,
    GET, VAL, GET, BYTE, ...C(127), AND, GET, SHIFT, SHL, OR, SET, VAL,
    GET, BYTE, ...C(128), LT_U, BR_IF, 0x01,
    GET, SHIFT, ...C(7), ADD, TEE, SHIFT, ...C(28), GT_U, IF, VOID, ...fail, END,
    BR, 0x00,
    END,
    END
  ];
  const zigzag = [
    GET, VAL, ...C(1), SHR_U,
    ...C(0), GET, VAL, ...C(1), AND, SUB,
    XOR, SET, VAL
  ];
  const flush: number[] = [
    GET, WRITE, GET, PART_START, GT_U,
    IF, VOID,
    GET, PARTS, GET, PART_WRITE, ...C(4), MUL, ADD, ...C(4), ADD, GET, PARTS_END, GT_U,
    IF, VOID, ...fail, END,
    GET, PARTS, GET, PART_WRITE, ...C(4), MUL, ADD, GET, WRITE, ...STORE,
    GET, PART_WRITE, ...C(1), ADD, SET, PART_WRITE,
    GET, WRITE, SET, PART_START,
    END
  ];
  const closePath: number[] = [
    GET, WRITE, GET, PART_START, GT_U,
    IF, VOID,
    GET, XY, GET, WRITE, ...C(1), ADD, ...C(8), MUL, ADD, GET, XY_END, GT_U,
    IF, VOID, ...fail, END,
    GET, XY, GET, WRITE, ...C(8), MUL, ADD,
    GET, XY, GET, PART_START, ...C(8), MUL, ADD, ...LOAD, ...STORE,
    GET, XY, GET, WRITE, ...C(8), MUL, ADD, ...C(4), ADD,
    GET, XY, GET, PART_START, ...C(8), MUL, ADD, ...C(4), ADD, ...LOAD, ...STORE,
    GET, WRITE, ...C(1), ADD, SET, WRITE,
    END,
    ...flush
  ];

  return [
    0x01, 0x0c, 0x7f,
    GET, IN, SET, POS,
    BLOCK, VOID,
    LOOP, VOID,
    GET, POS, GET, IN_END, GE_U, BR_IF, 0x01,
    ...readVarint,
    GET, VAL, ...C(7), AND, SET, ID,
    GET, VAL, ...C(3), SHR_U, SET, COUNT,
    GET, ID, ...C(1), EQ, GET, ID, ...C(2), EQ, OR,
    IF, VOID,
    GET, ID, ...C(1), EQ, IF, VOID, ...flush, END,
    ...C(0), SET, I,
    BLOCK, VOID,
    LOOP, VOID,
    GET, I, GET, COUNT, GE_U, BR_IF, 0x01,
    GET, XY, GET, WRITE, ...C(1), ADD, ...C(8), MUL, ADD, GET, XY_END, GT_U,
    IF, VOID, ...fail, END,
    ...readVarint, ...zigzag, GET, X, GET, VAL, ADD, SET, X,
    ...readVarint, ...zigzag, GET, Y, GET, VAL, ADD, SET, Y,
    GET, XY, GET, WRITE, ...C(8), MUL, ADD, GET, X, ...STORE,
    GET, XY, GET, WRITE, ...C(8), MUL, ADD, ...C(4), ADD, GET, Y, ...STORE,
    GET, WRITE, ...C(1), ADD, SET, WRITE,
    GET, I, ...C(1), ADD, SET, I,
    BR, 0x00,
    END,
    END,
    ELSE,
    GET, ID, ...C(7), EQ,
    IF, VOID, ...closePath,
    ELSE, BR, 0x03,
    END,
    END,
    BR, 0x00,
    END,
    END,
    ...flush,
    ...C(0), GET, WRITE, ...STORE,
    ...C(4), GET, PART_WRITE, ...STORE,
    ...C(0),
    END
  ];
}
