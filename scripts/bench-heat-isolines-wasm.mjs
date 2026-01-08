import { performance } from "node:perf_hooks";
import {
  buildHeatContoursWasm,
  buildHeatContoursWasmUnsafe,
  heatContoursWasmSupported
} from "../dist/services/heat-isolines-wasm.js";

const rawSize = Number(process.env.SIZE) || 0;
const rawLevels = Number(process.env.LEVELS) || 0;
const SIZE = rawSize > 0 ? Math.max(32, Math.floor(rawSize)) : 0;
const LEVELS = rawLevels > 0 ? Math.max(1, Math.min(24, Math.floor(rawLevels))) : 0;
const FIELD = process.env.FIELD || "";
const RUNS = Math.max(1, Number(process.env.RUNS) || 0);
const MATRIX = process.env.MATRIX === "1";

const cases = MATRIX
  ? [
      ...[256, 512, 1024].flatMap((size) => [1, 4, 8, 16].flatMap((levels) => ["smooth", "noisy", "islands"].map((field) => ({ size, levels, field }))))
    ]
  : SIZE
    ? [{ size: SIZE, levels: LEVELS || 8, field: FIELD || "noisy" }]
    : [
        { size: 256, levels: 4, field: "noisy" },
        { size: 512, levels: 8, field: "noisy" },
        { size: 1024, levels: 8, field: "smooth" }
      ];

console.log(`Orihon Heat-WASM P0 contours benchmark · Node ${process.version} · ${process.platform}/${process.arch}`);
console.log(`WASM=${heatContoursWasmSupported()} · --expose-gc=${typeof global.gc === "function"} · matrix=${MATRIX}`);

for (const c of cases) {
  const grid = makeField(c.size, c.field);
  const thresholds = makeLevels(grid, c.levels);
  const runs = RUNS || (c.size >= 1024 ? 3 : c.size >= 512 ? 5 : 7);

  // warm
  buildHeatContoursWasm(grid, c.size, c.size, thresholds);
  currentJsContours(grid, c.size, c.size, thresholds);

  const js = timed(runs, () => currentJsContours(grid, c.size, c.size, thresholds));
  const snap = timed(runs, () => buildHeatContoursWasm(grid, c.size, c.size, thresholds));
  const unsafe = timed(runs, () => buildHeatContoursWasmUnsafe(grid, c.size, c.size, thresholds));
  const profile = {};
  const out = buildHeatContoursWasm(grid, c.size, c.size, thresholds, profile);

  console.log(`\n=== ${c.field} ${c.size}² · levels=${c.levels} ===`);
  console.log(`JS current segments+Map stitch  ${fmt(js.median)} median · ${fmt(js.p95)} p95`);
  console.log(`WASM snapshot                  ${fmt(snap.median)} median · ${fmt(snap.p95)} p95`);
  console.log(`WASM unsafe                    ${fmt(unsafe.median)} median · ${fmt(unsafe.p95)} p95`);
  console.log(`speedup snapshot vs JS         ${(js.median / snap.median).toFixed(2)}x`);
  console.log(`snapshot tax                   ${fmt(snap.median - unsafe.median)} median delta`);
  if (out) {
    console.log(`segments / lines / vertices    ${num(profile.segments)} / ${num(out.lineCount)} / ${num(out.vertexCount)}`);
    console.log(`grid / scratch / output        ${bytes(profile.gridBytes)} / ${bytes(profile.scratchBytes)} / ${bytes(profile.outputBytes)}`);
    console.log(`WASM memory                    ${bytes(profile.wasmMemoryBytes)}`);
    console.log(`input copy                     ${fmt(profile.inputCopyMs)}`);
    console.log(`count pass                     ${fmt(profile.countMs)}`);
    console.log(`build pass                     ${fmt(profile.buildMs)}`);
    console.log(`snapshot                       ${fmt(profile.snapshotMs)}`);
    console.log(`views                          ${fmt(profile.viewsMs)}`);
    console.log(`total profiled                 ${fmt(profile.totalMs)}`);
  }
}

function timed(runs, fn) {
  const values = [];
  for (let i = 0; i < runs; i++) {
    global.gc?.();
    const t0 = performance.now();
    fn();
    values.push(performance.now() - t0);
  }
  values.sort((a, b) => a - b);
  return {
    median: values[Math.floor(values.length / 2)],
    p95: values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]
  };
}

function makeField(size, kind) {
  const out = new Float32Array(size * size);
  let seed = 0x12345678;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const centers = [
    [0.18, 0.2], [0.34, 0.68], [0.53, 0.37], [0.72, 0.76], [0.84, 0.28],
    [0.15, 0.82], [0.62, 0.16], [0.9, 0.58], [0.43, 0.9]
  ];
  for (let y = 0; y < size; y++) {
    const fy = y / Math.max(1, size - 1);
    for (let x = 0; x < size; x++) {
      const fx = x / Math.max(1, size - 1);
      let v = 0;
      if (kind === "smooth") {
        v = 0.85 * gauss(fx, fy, 0.31, 0.43, 0.022) +
            1.0 * gauss(fx, fy, 0.71, 0.62, 0.031) +
            0.18 * (Math.sin(fx * 10) * Math.cos(fy * 8) + 1);
      } else if (kind === "islands") {
        for (const [cx, cy] of centers) v += gauss(fx, fy, cx, cy, 0.0014);
      } else {
        v = 0.62 * gauss(fx, fy, 0.5, 0.5, 0.11) + rnd() * 0.62;
      }
      out[y * size + x] = Math.max(0, v);
    }
  }
  return out;
}

function gauss(x, y, cx, cy, sigma2) {
  const dx = x - cx;
  const dy = y - cy;
  return Math.exp(-(dx * dx + dy * dy) / sigma2);
}

function makeLevels(grid, count) {
  let peak = 0;
  for (const v of grid) if (v > peak) peak = v;
  return Float32Array.from({ length: count }, (_, i) => peak * ((i + 1) / (count + 1)));
}

// Current Orihon reference path: JS marching-squares -> endpoint strings -> Map adjacency.
function currentJsContours(grid, cols, rows, thresholds) {
  let segmentsTotal = 0;
  let lines = 0;
  let vertices = 0;
  for (const threshold of thresholds) {
    const segments = marchingSquaresSegments(grid, cols, rows, threshold);
    segmentsTotal += segments.length;
    const chains = connectSegments(segments);
    lines += chains.length;
    for (const chain of chains) vertices += chain.length;
  }
  return { segments: segmentsTotal, lines, vertices };
}

function marchingSquaresSegments(grid, cols, rows, threshold) {
  const out = [];
  const lerp = (a, b, va, vb) => {
    const d = vb - va;
    if (Math.abs(d) < 1e-12) return (a + b) * 0.5;
    return a + ((threshold - va) / d) * (b - a);
  };
  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const i = y * cols + x;
      const tl = grid[i], tr = grid[i + 1], br = grid[i + cols + 1], bl = grid[i + cols];
      const code = (tl >= threshold ? 8 : 0) | (tr >= threshold ? 4 : 0) | (br >= threshold ? 2 : 0) | (bl >= threshold ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const top = [lerp(x, x + 1, tl, tr), y];
      const right = [x + 1, lerp(y, y + 1, tr, br)];
      const bottom = [lerp(x, x + 1, bl, br), y + 1];
      const left = [x, lerp(y, y + 1, tl, bl)];
      switch (code) {
        case 1: case 14: out.push([left, bottom]); break;
        case 2: case 13: out.push([bottom, right]); break;
        case 3: case 12: out.push([left, right]); break;
        case 4: case 11: out.push([top, right]); break;
        case 5: {
          const avg = (tl + tr + br + bl) * 0.25;
          if (avg >= threshold) out.push([left, top], [bottom, right]);
          else out.push([left, bottom], [top, right]);
          break;
        }
        case 6: case 9: out.push([top, bottom]); break;
        case 7: case 8: out.push([left, top]); break;
        case 10: {
          const avg = (tl + tr + br + bl) * 0.25;
          if (avg >= threshold) out.push([left, bottom], [top, right]);
          else out.push([left, top], [bottom, right]);
          break;
        }
      }
    }
  }
  return out;
}

function connectSegments(segments) {
  if (!segments.length) return [];
  const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const used = new Uint8Array(segments.length);
  const chains = [];
  const ends = new Map();
  for (let i = 0; i < segments.length; i++) {
    for (const p of segments[i]) {
      const k = key(p);
      let list = ends.get(k);
      if (!list) ends.set(k, list = []);
      list.push(i);
    }
  }
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const [a0, b0] = segments[start];
    const chain = [a0, b0];
    let head = b0;
    for (;;) {
      const candidates = ends.get(key(head));
      if (!candidates) break;
      let nextIdx = -1;
      for (const idx of candidates) if (!used[idx]) { nextIdx = idx; break; }
      if (nextIdx < 0) break;
      used[nextIdx] = 1;
      const [a, b] = segments[nextIdx];
      if (key(a) === key(head)) { chain.push(b); head = b; }
      else { chain.push(a); head = a; }
    }
    let tail = a0;
    for (;;) {
      const candidates = ends.get(key(tail));
      if (!candidates) break;
      let nextIdx = -1;
      for (const idx of candidates) if (!used[idx]) { nextIdx = idx; break; }
      if (nextIdx < 0) break;
      used[nextIdx] = 1;
      const [a, b] = segments[nextIdx];
      if (key(a) === key(tail)) { chain.unshift(b); tail = b; }
      else { chain.unshift(a); tail = a; }
    }
    chains.push(chain);
  }
  return chains;
}

function fmt(v) { return `${Number(v || 0).toFixed(3)}ms`; }
function num(v) { return Math.round(Number(v || 0)).toLocaleString("en-US"); }
function bytes(v) {
  const n = Number(v || 0);
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${Math.round(n)}B`;
}
