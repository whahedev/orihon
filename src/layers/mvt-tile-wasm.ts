import type { MVTDecodeOptions, PackedMVTLayer, PackedVectorTile } from "./mvt.js";
import type { VectorTileCoordinates } from "./vector-tile-layer.js";
import { alignWasm8, decodeBase64Bytes, tryGrowWasmMemory } from "../services/wasm-utils.js";

type PbfValue = string | number | boolean | null;
type Profile = Record<string, number | boolean | string>;
type InternalOptions = MVTDecodeOptions & { __mvtTileWasmProfile?: Profile };

interface TileWasm {
  decodeTile: (
    inputPtr: number,
    inputLength: number,
    filterPtr: number,
    filterLength: number,
    outputPtr: number,
    outputCapacity: number,
    maxFeatures: number,
    maxStringLength: number
  ) => number;
  memory: WebAssembly.Memory;
  heapBase: number;
}

interface BlobDecode {
  buffer: ArrayBuffer;
  baseOffset: number;
  byteLength: number;
  wasm: TileWasm;
  retries: number;
  loadMs: number;
  memoryMs: number;
  inputCopyMs: number;
  wasmMs: number;
}

const HEADER_WORDS = 16;
const HEADER_SIZE = HEADER_WORDS * 4;
const LAYER_DESC_WORDS = 32;
const LAYER_DESC_SIZE = LAYER_DESC_WORDS * 4;
const VALUE_DESC_SIZE = 24;
const MAGIC = 0x3254564f;
const VERSION = 2;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const textDecoder = typeof TextDecoder === "undefined" ? null : new TextDecoder();
const textEncoder = typeof TextEncoder === "undefined" ? null : new TextEncoder();

let tileWasm: TileWasm | null | undefined;
let tileWasmError = "";

// clang --target=wasm32 -O3 -fno-builtin -nostdlib
// scripts/wasm/mvt-tile-decoder.c. The production decoder uses an exact two-pass per layer: pass 1 counts packed
// output, pass 2 emits directly into one self-describing blob. It never builds
// a Tile/Layer/Feature object model.
const MVT_TILE_WASM_BASE64 = "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";

export function mvtTileWasmSupported(): boolean {
  return loadTileWasm() != null;
}

export function mvtTileWasmError(): string {
  loadTileWasm();
  return tileWasmError;
}

/** Stable production path: one WASM output blob -> one snapshot copy -> typed views. */
export function decodePackedMVTTileWasm(
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions = {}
): PackedVectorTile | null {
  return decodePackedMVTTileWasmMode(data, tile, options, true);
}

/** Benchmark-only live views. Valid only until the next tile decode/grow. */
export function decodePackedMVTTileWasmUnsafe(
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions = {}
): PackedVectorTile | null {
  return decodePackedMVTTileWasmMode(data, tile, options, false);
}

function decodePackedMVTTileWasmMode(
  data: ArrayBuffer | Uint8Array,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">,
  options: MVTDecodeOptions,
  stableSnapshot: boolean
): PackedVectorTile | null {
  const profile = (options as InternalOptions).__mvtTileWasmProfile;
  const now = (): number => typeof performance !== "undefined" ? performance.now() : Date.now();
  const started = profile ? now() : 0;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const maxBytes = options.maxBytes ?? 2_097_152;
  const maxFeatures = clampU32(options.maxFeatures ?? 16_384);
  const maxStringLength = clampU32(options.maxStringLength ?? 8_192);

  if (bytes.byteLength > maxBytes) {
    if (profile) {
      profile.tileWasm = true;
      profile.snapshot = stableSnapshot;
      profile.inputBytes = bytes.byteLength;
      profile.outputBytes = 0;
      profile.layers = 0;
      profile.features = 0;
      profile.retries = 0;
      profile.totalMs = now() - started;
    }
    return { x: tile.x, y: tile.y, z: tile.z, layers: [] };
  }

  try {
    const blob = decodeTileBlob(bytes, options, maxFeatures, maxStringLength, profile);
    if (!blob) return null;

    const snapshotStarted = profile ? now() : 0;
    let buffer = blob.buffer;
    let baseOffset = blob.baseOffset;
    if (stableSnapshot) {
      buffer = blob.buffer.slice(blob.baseOffset, blob.baseOffset + blob.byteLength);
      baseOffset = 0;
    }
    const snapshotFinished = profile ? now() : 0;

    const viewsStarted = profile ? now() : 0;
    const packed = materializePackedTileBlob(buffer, baseOffset, blob.byteLength, tile);
    const viewsFinished = profile ? now() : 0;

    if (profile) {
      let featureCount = 0;
      for (let i = 0; i < packed.layers.length; i++) featureCount += packed.layers[i].types.length;
      profile.tileWasm = true;
      profile.snapshot = stableSnapshot;
      profile.inputBytes = bytes.byteLength;
      profile.outputBytes = blob.byteLength;
      const liveBytes = estimateLiveBlobBytes(buffer, baseOffset, blob.byteLength);
      profile.liveBytes = liveBytes;
      profile.arenaWasteBytes = Math.max(0, blob.byteLength - liveBytes);
      profile.arenaWasteRatio = liveBytes > 0 ? blob.byteLength / liveBytes : 1;
      profile.layers = packed.layers.length;
      profile.features = featureCount;
      profile.retries = blob.retries;
      profile.loadMs = blob.loadMs;
      profile.memoryMs = blob.memoryMs;
      profile.inputCopyMs = blob.inputCopyMs;
      profile.wasmMs = blob.wasmMs;
      profile.outputCopyMs = snapshotFinished - snapshotStarted;
      profile.metadataMs = viewsFinished - viewsStarted;
      profile.totalMs = viewsFinished - started;
    }
    return packed;
  } catch (error) {
    if (profile) {
      profile.tileWasm = false;
      profile.snapshot = stableSnapshot;
      profile.fallback = error instanceof Error ? error.message : String(error);
      profile.totalMs = now() - started;
    }
    return null;
  }
}

function decodeTileBlob(
  bytes: Uint8Array,
  options: MVTDecodeOptions,
  maxFeatures: number,
  maxStringLength: number,
  profile?: Profile
): BlobDecode | null {
  const now = (): number => typeof performance !== "undefined" ? performance.now() : Date.now();
  const loadStarted = profile ? now() : 0;
  const wasm = loadTileWasm();
  const loadFinished = profile ? now() : 0;
  if (!wasm) {
    if (profile) {
      profile.tileWasm = false;
      profile.fallback = tileWasmError || "wasm-unavailable";
      profile.loadMs = loadFinished - loadStarted;
    }
    return null;
  }

  const filterBytes = encodeLayerFilter(options.layer);
  if (filterBytes == null) return null;
  const inputPtr = alignWasm8(wasm.heapBase);
  const filterPtr = alignWasm8(inputPtr + bytes.byteLength);
  const outputPtr = alignWasm8(filterPtr + filterBytes.byteLength + 64);
  let outputCapacity = initialOutputCapacity(bytes.byteLength);

  const memoryStarted = profile ? now() : 0;
  if (!tryGrowWasmMemory(wasm.memory, outputPtr + outputCapacity)) return null;
  const memoryFinished = profile ? now() : 0;

  const inputCopyStarted = profile ? now() : 0;
  let heap = new Uint8Array(wasm.memory.buffer);
  heap.set(bytes, inputPtr);
  if (filterBytes.byteLength) heap.set(filterBytes, filterPtr);
  const inputCopyFinished = profile ? now() : 0;

  let result = -2;
  let retries = 0;
  const wasmStarted = profile ? now() : 0;
  while (result === -2 && retries <= 6) {
    result = wasm.decodeTile(
      inputPtr,
      bytes.byteLength,
      filterPtr,
      filterBytes.byteLength,
      outputPtr,
      outputCapacity,
      maxFeatures,
      maxStringLength
    );
    if (result !== -2) break;
    retries++;
    if (outputCapacity >= MAX_OUTPUT_BYTES) return null;
    outputCapacity = Math.min(MAX_OUTPUT_BYTES, outputCapacity * 2);
    if (!tryGrowWasmMemory(wasm.memory, outputPtr + outputCapacity)) return null;
    // memory.grow replaces memory.buffer; tile bytes remain at the same address.
    heap = new Uint8Array(wasm.memory.buffer);
  }
  const wasmFinished = profile ? now() : 0;
  if (result <= 0 || result > outputCapacity) return null;

  // Validate enough of the self-describing header before handing out live views.
  const header = new Uint32Array(wasm.memory.buffer, outputPtr, HEADER_WORDS);
  if (header[0] !== MAGIC || header[1] !== VERSION || header[2] !== result) return null;

  return {
    buffer: wasm.memory.buffer,
    baseOffset: outputPtr,
    byteLength: result,
    wasm,
    retries,
    loadMs: loadFinished - loadStarted,
    memoryMs: memoryFinished - memoryStarted,
    inputCopyMs: inputCopyFinished - inputCopyStarted,
    wasmMs: wasmFinished - wasmStarted
  };
}

function materializePackedTileBlob(
  buffer: ArrayBuffer,
  baseOffset: number,
  byteLength: number,
  tile: Pick<VectorTileCoordinates, "x" | "y" | "z">
): PackedVectorTile {
  assertBlobRange(buffer, baseOffset, byteLength, 0, HEADER_SIZE);
  const header = new Uint32Array(buffer, baseOffset, HEADER_WORDS);
  if (header[0] !== MAGIC || header[1] !== VERSION || header[2] !== byteLength) {
    throw new Error("MVT tile WASM blob header");
  }
  const layerCount = header[3];
  const descOffset = header[6];
  const descBytes = header[7];
  if (descBytes !== layerCount * LAYER_DESC_SIZE) throw new Error("MVT tile WASM descriptor size");
  assertBlobRange(buffer, baseOffset, byteLength, descOffset, descBytes);
  const descs = new Uint32Array(buffer, baseOffset + descOffset, layerCount * LAYER_DESC_WORDS);
  const valueView = new DataView(buffer);
  const layers = new Array<PackedMVTLayer>(layerCount);

  for (let li = 0; li < layerCount; li++) {
    const d = li * LAYER_DESC_WORDS;
    const nameOffset = descs[d];
    const nameLength = descs[d + 1];
    const extent = descs[d + 2];
    const keyCount = descs[d + 3];
    const keyRangesOffset = descs[d + 4];
    const keyRangesLength = descs[d + 5];
    const valueCount = descs[d + 6];
    const valueDescOffset = descs[d + 7];
    const valueDescBytes = descs[d + 8];
    const featureCount = descs[d + 9];
    const typesOffset = descs[d + 10];
    const typesLength = descs[d + 11];
    const idsOffset = descs[d + 12];
    const idsLength = descs[d + 13];
    const idPresentOffset = descs[d + 14];
    const idPresentLength = descs[d + 15];
    const vertexOffsetsOffset = descs[d + 16];
    const vertexOffsetsLength = descs[d + 17];
    const partOffsetsOffset = descs[d + 18];
    const partOffsetsLength = descs[d + 19];
    const partEndsOffset = descs[d + 20];
    const partEndsLength = descs[d + 21];
    const tagOffsetsOffset = descs[d + 22];
    const tagOffsetsLength = descs[d + 23];
    const tagsOffset = descs[d + 24];
    const tagsLength = descs[d + 25];
    const xyOffset = descs[d + 26];
    const xyLength = descs[d + 27];

    if (keyRangesLength !== keyCount * 2 || valueDescBytes !== valueCount * VALUE_DESC_SIZE ||
        typesLength !== featureCount || idsLength !== featureCount || idPresentLength !== featureCount ||
        vertexOffsetsLength !== featureCount + 1 || partOffsetsLength !== featureCount + 1 ||
        tagOffsetsLength !== featureCount + 1 || (xyLength & 1) !== 0) {
      throw new Error("MVT tile WASM descriptor contract");
    }

    assertBlobRange(buffer, baseOffset, byteLength, nameOffset, nameLength);
    assertBlobRange(buffer, baseOffset, byteLength, keyRangesOffset, keyRangesLength * 4);
    assertBlobRange(buffer, baseOffset, byteLength, valueDescOffset, valueDescBytes);
    assertBlobRange(buffer, baseOffset, byteLength, typesOffset, typesLength);
    assertBlobRange(buffer, baseOffset, byteLength, idsOffset, idsLength * 8);
    assertBlobRange(buffer, baseOffset, byteLength, idPresentOffset, idPresentLength);
    assertBlobRange(buffer, baseOffset, byteLength, vertexOffsetsOffset, vertexOffsetsLength * 4);
    assertBlobRange(buffer, baseOffset, byteLength, partOffsetsOffset, partOffsetsLength * 4);
    assertBlobRange(buffer, baseOffset, byteLength, partEndsOffset, partEndsLength * 4);
    assertBlobRange(buffer, baseOffset, byteLength, tagOffsetsOffset, tagOffsetsLength * 4);
    assertBlobRange(buffer, baseOffset, byteLength, tagsOffset, tagsLength * 4);
    assertBlobRange(buffer, baseOffset, byteLength, xyOffset, xyLength * 4);

    const keyRanges = new Uint32Array(buffer, baseOffset + keyRangesOffset, keyRangesLength);
    const keys = new Array<string>(keyCount);
    for (let i = 0; i < keyCount; i++) {
      keys[i] = blobString(buffer, baseOffset, byteLength, keyRanges[i * 2], keyRanges[i * 2 + 1]);
    }

    const values = new Array<PbfValue>(valueCount);
    for (let i = 0; i < valueCount; i++) {
      const offset = baseOffset + valueDescOffset + i * VALUE_DESC_SIZE;
      const kind = valueView.getUint32(offset, true);
      if (kind === 1) {
        values[i] = blobString(
          buffer,
          baseOffset,
          byteLength,
          valueView.getUint32(offset + 4, true),
          valueView.getUint32(offset + 8, true)
        );
      } else if (kind === 2) {
        values[i] = valueView.getFloat64(offset + 16, true);
      } else if (kind === 3) {
        values[i] = Boolean(valueView.getFloat64(offset + 16, true));
      } else {
        values[i] = null;
      }
    }

    const idNumbers = new Float64Array(buffer, baseOffset + idsOffset, idsLength);
    const idPresent = new Uint8Array(buffer, baseOffset + idPresentOffset, idPresentLength);
    const ids: Array<string | number | undefined> = new Array(featureCount);
    for (let i = 0; i < featureCount; i++) ids[i] = idPresent[i] ? idNumbers[i] : undefined;

    layers[li] = {
      name: blobString(buffer, baseOffset, byteLength, nameOffset, nameLength),
      extent,
      keys,
      values,
      xy: new Int32Array(buffer, baseOffset + xyOffset, xyLength),
      types: new Uint8Array(buffer, baseOffset + typesOffset, typesLength),
      ids,
      vertexOffsets: new Uint32Array(buffer, baseOffset + vertexOffsetsOffset, vertexOffsetsLength),
      partOffsets: new Uint32Array(buffer, baseOffset + partOffsetsOffset, partOffsetsLength),
      partEnds: new Uint32Array(buffer, baseOffset + partEndsOffset, partEndsLength),
      tagOffsets: new Uint32Array(buffer, baseOffset + tagOffsetsOffset, tagOffsetsLength),
      tags: new Uint32Array(buffer, baseOffset + tagsOffset, tagsLength)
    };
  }

  return { x: tile.x, y: tile.y, z: tile.z, layers };
}

function estimateLiveBlobBytes(buffer: ArrayBuffer, baseOffset: number, byteLength: number): number {
  const header = new Uint32Array(buffer, baseOffset, HEADER_WORDS);
  const layerCount = header[3];
  const descOffset = header[6];
  const descs = new Uint32Array(buffer, baseOffset + descOffset, layerCount * LAYER_DESC_WORDS);
  const data = new DataView(buffer);
  let total = HEADER_SIZE + layerCount * LAYER_DESC_SIZE;
  for (let li = 0; li < layerCount; li++) {
    const d = li * LAYER_DESC_WORDS;
    total += descs[d + 1]; // layer name
    total += descs[d + 5] * 4; // key ranges
    const keyRanges = new Uint32Array(buffer, baseOffset + descs[d + 4], descs[d + 5]);
    for (let i = 1; i < keyRanges.length; i += 2) total += keyRanges[i];
    total += descs[d + 8]; // value descriptors
    for (let i = 0; i < descs[d + 6]; i++) {
      const valueOffset = baseOffset + descs[d + 7] + i * VALUE_DESC_SIZE;
      if (data.getUint32(valueOffset, true) === 1) total += data.getUint32(valueOffset + 8, true);
    }
    total += descs[d + 11]; // types u8
    total += descs[d + 13] * 8; // ids f64
    total += descs[d + 15]; // id-present u8
    total += descs[d + 17] * 4; // vertex offsets
    total += descs[d + 19] * 4; // part offsets
    total += descs[d + 21] * 4; // part ends
    total += descs[d + 23] * 4; // tag offsets
    total += descs[d + 25] * 4; // tags
    total += descs[d + 27] * 4; // xy
  }
  return Math.min(byteLength, total);
}

function encodeLayerFilter(layer: MVTDecodeOptions["layer"]): Uint8Array | null {
  if (!layer) return new Uint8Array(0);
  if (!textEncoder) return null;
  const names = Array.isArray(layer) ? layer : [layer];
  if (names.length === 0) return new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  const encoded = new Array<Uint8Array>(names.length);
  let total = 0;
  for (let i = 0; i < names.length; i++) {
    encoded[i] = textEncoder.encode(String(names[i]));
    total += 4 + encoded[i].byteLength;
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (let i = 0; i < encoded.length; i++) {
    const name = encoded[i];
    view.setUint32(offset, name.byteLength, true);
    offset += 4;
    out.set(name, offset);
    offset += name.byteLength;
  }
  return out;
}

function loadTileWasm(): TileWasm | null {
  if (tileWasm !== undefined) return tileWasm;
  tileWasm = null;
  if (typeof WebAssembly === "undefined") {
    tileWasmError = "WebAssembly is unavailable";
    return null;
  }
  try {
    const binary = decodeBase64Bytes(MVT_TILE_WASM_BASE64);
    const module = new WebAssembly.Module(binary);
    const instance = new WebAssembly.Instance(module, {});
    const exported = instance.exports as unknown as {
      decode_tile: TileWasm["decodeTile"];
      memory: WebAssembly.Memory;
      __heap_base: WebAssembly.Global;
    };
    if (typeof exported.decode_tile !== "function" || !exported.memory || !exported.__heap_base) {
      tileWasmError = "MVT tile WASM exports missing";
      return null;
    }
    tileWasm = {
      decodeTile: exported.decode_tile,
      memory: exported.memory,
      heapBase: Number(exported.__heap_base.value)
    };
    return tileWasm;
  } catch (error) {
    tileWasmError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

function initialOutputCapacity(inputBytes: number): number {
  // Start modestly and grow geometrically on rare capacity misses. The exact
  // two-pass decoder normally fits inside this estimate without retries.
  return Math.min(MAX_OUTPUT_BYTES, Math.max(65_536, alignWasm8(inputBytes * 4 + 32_768)));
}

function blobString(buffer: ArrayBuffer, baseOffset: number, blobLength: number, offset: number, length: number): string {
  if (!length) return "";
  assertBlobRange(buffer, baseOffset, blobLength, offset, length);
  return textDecoder ? textDecoder.decode(new Uint8Array(buffer, baseOffset + offset, length)) : "";
}

function assertBlobRange(buffer: ArrayBuffer, baseOffset: number, blobLength: number, offset: number, length: number): void {
  if (baseOffset < 0 || blobLength < 0 || baseOffset > buffer.byteLength || blobLength > buffer.byteLength - baseOffset ||
      offset < 0 || length < 0 || offset > blobLength || length > blobLength - offset) {
    throw new Error("MVT tile WASM blob range");
  }
}

function clampU32(value: number): number {
  if (!Number.isFinite(value)) return 0xffff_ffff;
  if (value <= 0) return 0;
  return Math.min(0xffff_ffff, Math.floor(value)) >>> 0;
}
