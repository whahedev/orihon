import fs from "node:fs";
import { performance } from "node:perf_hooks";

const encoder = new TextEncoder();
const COUNT = Number(process.env.COUNT || 5000);
const VERTS = Math.max(2, Number(process.env.VERTS || 2));
const RUNS = Number(process.env.RUNS || 9);
const bytes = makeSyntheticTile(COUNT, VERTS);

const exact = await loadWasm(new URL("./wasm/mvt-tile-decoder.wasm", import.meta.url));
const streaming = await loadWasm(new URL("./wasm/mvt-tile-decoder-streaming-experiment.wasm", import.meta.url));

console.log(`Orihon MVT arena strategy benchmark · Node ${process.version}`);
console.log(`features=${COUNT.toLocaleString()} · verts=${VERTS} · PBF=${bytes.byteLength.toLocaleString()} bytes · runs=${RUNS}`);

for (const [name, wasm] of [["exact two-pass", exact], ["growable streaming", streaming]]) {
  for (let i = 0; i < 3; i++) decode(wasm, bytes);
  const times = [];
  let last;
  for (let i = 0; i < RUNS; i++) {
    global.gc?.();
    const t0 = performance.now();
    last = decode(wasm, bytes);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
  console.log(`${name.padEnd(20)} ${median.toFixed(3)}ms median · ${p95.toFixed(3)}ms p95 · blob=${last.length.toLocaleString()} · retries=${last.retries}`);
}

async function loadWasm(url) {
  const binary = fs.readFileSync(url);
  const { instance } = await WebAssembly.instantiate(binary, {});
  return { exports: instance.exports, heapBase: Number(instance.exports.__heap_base.value) };
}
function ensureMemory(memory, bytesNeeded) {
  if (bytesNeeded <= memory.buffer.byteLength) return;
  memory.grow(Math.ceil((bytesNeeded - memory.buffer.byteLength) / 65536));
}
function decode(wasm, input) {
  const inputPtr = align8(wasm.heapBase);
  const filterPtr = align8(inputPtr + input.byteLength);
  const outputPtr = align8(filterPtr + 64);
  let capacity = Math.max(65536, align8(input.byteLength * 4 + 32768));
  let retries = 0;
  for (;;) {
    ensureMemory(wasm.exports.memory, outputPtr + capacity);
    const heap = new Uint8Array(wasm.exports.memory.buffer);
    heap.set(input, inputPtr);
    const result = wasm.exports.decode_tile(inputPtr, input.byteLength, filterPtr, 0, outputPtr, capacity, 0xffffffff, 8192);
    if (result === -2 && retries < 6) {
      retries++;
      capacity *= 2;
      continue;
    }
    if (result <= 0) throw new Error(`decode failed: ${result}`);
    return { length: result, retries };
  }
}
function align8(v) { return (v + 7) & ~7; }
function varint(value) {
  let n = BigInt(value); const out = [];
  while (n > 0x7fn) { out.push(Number((n & 0x7fn) | 0x80n)); n >>= 7n; }
  out.push(Number(n)); return out;
}
function key(field, wire) { return varint((field << 3) | wire); }
function bytesField(field, data) { return [...key(field, 2), ...varint(data.length), ...data]; }
function varintField(field, value) { return [...key(field, 0), ...varint(value)]; }
function zz(v) { return v < 0 ? (-v * 2 - 1) >>> 0 : (v * 2) >>> 0; }
function geometry(seed, vertices, close) {
  let x = (seed * 17) & 4095, y = (seed * 29) & 4095;
  const out = [9, ...varint(zz(x)), ...varint(zz(y))];
  if (vertices > 1) {
    out.push(...varint(((vertices - 1) << 3) | 2));
    for (let i = 1; i < vertices; i++) {
      const nx = (x + 7 + (seed + i) % 31) & 4095;
      const ny = (y + 5 + (seed * 3 + i) % 23) & 4095;
      out.push(...varint(zz(nx - x)), ...varint(zz(ny - y)));
      x = nx; y = ny;
    }
  }
  if (close) out.push(15);
  return out;
}
function feature(id, type, geom) {
  return [...varintField(1, id), ...bytesField(2, [0, 0, 1, 1]), ...varintField(3, type), ...bytesField(4, geom)];
}
function valueString(v) { return bytesField(1, [...encoder.encode(v)]); }
function layer(name, start, count, vertices) {
  const out = [...bytesField(1, [...encoder.encode(name)])];
  for (let i = 0; i < count; i++) {
    const n = start + i;
    const type = n % 10 < 3 ? 1 : n % 10 < 8 ? 2 : 3;
    out.push(...bytesField(2, feature(n + 1, type, geometry(n, type === 1 ? 1 : vertices, type === 3))));
  }
  out.push(...bytesField(3, [...encoder.encode("class")]), ...bytesField(3, [...encoder.encode("rank")]));
  out.push(...bytesField(4, valueString(name)), ...bytesField(4, varintField(4, 7)));
  out.push(...varintField(5, 4096), ...varintField(15, 2));
  return out;
}
function makeSyntheticTile(count, vertices) {
  const a = Math.floor(count * 0.5), b = Math.floor(count * 0.3), c = count - a - b;
  return Uint8Array.from([
    ...bytesField(3, layer("roads", 0, a, vertices)),
    ...bytesField(3, layer("buildings", a, b, Math.max(4, Math.floor(vertices / 2)))),
    ...bytesField(3, layer("places", a + b, c, 2))
  ]);
}
