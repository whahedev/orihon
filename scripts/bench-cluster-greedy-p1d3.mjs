import { performance } from "node:perf_hooks";
import { buildGreedyClusterLayout } from "../dist/services/cluster-layout.js";

const MAX_LAT = 85.0511287798066;
const TILE_SIZE = 256;
const COUNT = Math.max(1, Number(process.env.COUNT) || 100_000);
const RUNS = COUNT >= 1_000_000 ? 3 : 5;

function fmt(ms) { return `${ms.toFixed(ms >= 100 ? 2 : 3)}ms`; }
function gc() { global.gc?.(); }
function median(values) { const a=[...values].sort((x,y)=>x-y); return a[Math.floor(a.length/2)]; }
function p95(values) { const a=[...values].sort((x,y)=>x-y); return a[Math.min(a.length-1, Math.ceil(a.length*0.95)-1)]; }

function makeInput(count) {
  const ids = Array.from({ length: count }, (_, id) => id);
  const coords = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 1000);
    const col = i - row * 1000;
    coords[i * 2] = 45 + (row % 1000) * 0.0005;
    coords[i * 2 + 1] = -120 + (col % 1000) * 0.0005;
  }
  return {
    ids,
    coords,
    zoomBucket: 8,
    gridSize: 50,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 8,
    clusterMinZoom: 0
  };
}

class LegacyDistanceGrid {
  constructor(cellSize) {
    this.cellSize = Math.max(1e-12, cellSize);
    this.radius2 = this.cellSize * this.cellSize;
    this.cols = new Map();
  }
  insert(x, y, id) {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    let row = this.cols.get(cx);
    if (!row) { row = new Map(); this.cols.set(cx, row); }
    let bucket = row.get(cy);
    if (!bucket) { bucket = []; row.set(cy, bucket); }
    bucket.push(id);
  }
  queryNearest(x, y, xs, ys) {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    let best = -1;
    let bestDist = this.radius2;
    for (let dx = -1; dx <= 1; dx++) {
      const row = this.cols.get(cx + dx);
      if (!row) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = row.get(cy + dy);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const id = bucket[i];
          const ddx = xs[id] - x;
          const ddy = ys[id] - y;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 <= bestDist) { bestDist = d2; best = id; }
        }
      }
    }
    return best;
  }
}

function project(lat, lng) {
  let clampedLat = lat;
  if (clampedLat > MAX_LAT) clampedLat = MAX_LAT;
  else if (clampedLat < -MAX_LAT) clampedLat = -MAX_LAT;
  const wrappedLng = ((lng + 180) % 360 + 360) % 360 - 180;
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  return {
    x: (wrappedLng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
  };
}

// Pre-P1-D3 reference path, kept only in this benchmark.
function legacyGreedy(input) {
  const count = Math.min(input.ids.length, Math.floor(input.coords.length / 2));
  const singles = [];
  const clusters = [];
  const z = Math.max(0, Math.min(input.clusterMaxZoom, Math.floor(input.zoomBucket)));
  const radius = Math.max(20, Number(input.gridSize) || 50);
  const grid = new LegacyDistanceGrid(radius / (TILE_SIZE * 2 ** z));
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const lats = new Float64Array(count);
  const lngs = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const la = input.coords[i * 2];
    const ln = input.coords[i * 2 + 1];
    const p = project(la, ln);
    xs[i] = p.x; ys[i] = p.y; lats[i] = la; lngs[i] = ln;
  }
  const ox = new Float64Array(count);
  const oy = new Float64Array(count);
  const assigned = new Uint8Array(count);
  const byOrigin = new Map();
  for (let i = 0; i < count; i++) {
    const px = xs[i];
    const py = ys[i];
    const origin = grid.queryNearest(px, py, ox, oy);
    if (origin >= 0) {
      let acc = byOrigin.get(origin);
      if (!acc) {
        acc = { lat: lats[origin], lng: lngs[origin], w: 1, leaves: [origin] };
        byOrigin.set(origin, acc);
        assigned[origin] = 1;
      }
      const w = acc.w;
      const nw = w + 1;
      ox[origin] = (ox[origin] * w + px) / nw;
      oy[origin] = (oy[origin] * w + py) / nw;
      acc.lat = (acc.lat * w + lats[i]) / nw;
      acc.lng = (acc.lng * w + lngs[i]) / nw;
      acc.w = nw;
      acc.leaves.push(i);
      assigned[i] = 1;
      continue;
    }
    ox[i] = px; oy[i] = py; grid.insert(px, py, i);
  }
  let clusterSeq = 0;
  for (const acc of byOrigin.values()) {
    if (acc.w < input.minPoints) {
      for (const leaf of acc.leaves) singles.push({ id: input.ids[leaf], lat: lats[leaf], lng: lngs[leaf] });
      continue;
    }
    const ids = new Array(acc.leaves.length);
    for (let i = 0; i < acc.leaves.length; i++) ids[i] = input.ids[acc.leaves[i]];
    clusters.push({ key: `g${z}:${clusterSeq++}`, lat: acc.lat, lng: acc.lng, ids, count: acc.w, nodeId: -1 });
  }
  for (let i = 0; i < count; i++) {
    if (!assigned[i]) singles.push({ id: input.ids[i], lat: lats[i], lng: lngs[i] });
  }
  return { clusters, singles };
}

function measure(fn, runs = RUNS) {
  const times = [];
  let last;
  for (let i = 0; i < runs; i++) {
    gc();
    const t0 = performance.now();
    last = fn();
    times.push(performance.now() - t0);
  }
  return { median: median(times), p95: p95(times), last };
}

function signature(result) {
  return {
    clusters: result.clusters.map((c) => ({ key: c.key, count: c.count, first: c.ids[0], last: c.ids.at(-1) })),
    singles: result.singles.map((s) => s.id)
  };
}

console.log(`Orihon P1-D2/D3 greedy benchmark · Node ${process.version} · ${process.platform}/${process.arch}`);
console.log(`COUNT=${COUNT.toLocaleString()} · runs=${RUNS} · --expose-gc=${global.gc ? "yes" : "no"}`);
console.log();

const input = makeInput(COUNT);
const verifyInput = makeInput(Math.min(COUNT, 20_000));
const legacyCheck = legacyGreedy(verifyInput);
const packedCheck = buildGreedyClusterLayout(verifyInput);
const same = JSON.stringify(signature(legacyCheck)) === JSON.stringify(signature(packedCheck));
console.log(`semantic check (sample ${verifyInput.ids.length.toLocaleString()}): ${same ? "PASS" : "FAIL"}`);
if (!same) process.exitCode = 1;

const legacy = measure(() => legacyGreedy(input));
const packed = measure(() => buildGreedyClusterLayout(input));
console.log(`legacy greedy: ${fmt(legacy.median)} median · ${fmt(legacy.p95)} p95`);
console.log(`packed greedy: ${fmt(packed.median)} median · ${fmt(packed.p95)} p95`);
console.log(`speedup: ${(legacy.median / packed.median).toFixed(2)}x`);
console.log(`result: clusters=${packed.last.clusters.length.toLocaleString()} singles=${packed.last.singles.length.toLocaleString()}`);
console.log();

const profile = {};
gc();
buildGreedyClusterLayout({ ...input, __greedyProfile: profile });
console.log("packed stage profile:");
console.log(`  projection:   ${fmt(Number(profile.projectionMs || 0))}`);
console.log(`  setup/grid:   ${fmt(Number(profile.setupMs || 0))}`);
console.log(`  scan/query:   ${fmt(Number(profile.scanMs || 0))}`);
console.log(`  materialize:  ${fmt(Number(profile.materializeMs || 0))}`);
console.log(`  total:        ${fmt(Number(profile.totalMs || 0))}`);
console.log(`  packed grid:  ${profile.packedGrid ? "yes" : "no"}`);
if (profile.packedGrid) {
  console.log(`  queries:      ${Number(profile.gridQueries || 0).toLocaleString()}`);
  console.log(`  inserts:      ${Number(profile.gridInserts || 0).toLocaleString()}`);
  console.log(`  hash probes:  ${Number(profile.hashProbes || 0).toLocaleString()}`);
  console.log(`  candidates:   ${Number(profile.candidateChecks || 0).toLocaleString()}`);
}
