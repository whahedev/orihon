import { performance } from "node:perf_hooks";
import { buildClusterIndex } from "../dist/services/cluster-layout.js";
import {
  buildClusterIndexWasm,
  buildClusterIndexWasmUnsafe,
  clusterIndexWasmSupported,
  clusterIndexWasmError
} from "../dist/services/cluster-index-wasm.js";

const COUNT = Math.max(1, Number(process.env.COUNT || 100_000));
const MAX_ZOOM = Math.max(0, Number(process.env.MAX_ZOOM || 8));
const RUNS = Math.max(1, Number(process.env.RUNS || (COUNT >= 1_000_000 ? 3 : COUNT >= 250_000 ? 5 : 7)));
const SAMPLE = Math.min(20_000, COUNT);

function fmt(n) { return new Intl.NumberFormat("en-US").format(n); }
function mb(n) { return `${(n / 1048576).toFixed(1)}MB`; }
function median(values) { const a=[...values].sort((x,y)=>x-y); return a[Math.floor(a.length/2)]; }
function p95(values) { const a=[...values].sort((x,y)=>x-y); return a[Math.min(a.length-1, Math.ceil(a.length*0.95)-1)]; }
function gc() { if (global.gc) global.gc(); }

function makeCoords(count, kind) {
  const coords = new Float64Array(count * 2);
  let state = 0x12345678;
  const rnd = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
  for (let i = 0; i < count; i++) {
    if (kind === "dense") {
      coords[i * 2] = 55.75 + (rnd() - 0.5) * 0.3;
      coords[i * 2 + 1] = 37.62 + (rnd() - 0.5) * 0.5;
    } else if (kind === "regional") {
      coords[i * 2] = 45 + rnd() * 20;
      coords[i * 2 + 1] = 20 + rnd() * 40;
    } else {
      coords[i * 2] = -80 + rnd() * 160;
      coords[i * 2 + 1] = -180 + rnd() * 360;
    }
  }
  return coords;
}

function inputFor(coords) {
  return {
    ids: [],
    coords,
    gridSize: 50,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: MAX_ZOOM,
    clusterMinZoom: 0
  };
}

function semantic(kind) {
  const coords = makeCoords(SAMPLE, kind);
  const input = inputFor(coords);
  const js = buildClusterIndex(input);
  const wa = buildClusterIndexWasm(coords, input);
  if (!wa || wa.nodeCount !== js.nodeCount || wa.trees.length !== js.trees.length) return false;
  for (const key of ["weight", "zoom", "parent", "firstChild", "nextSibling"]) {
    const a = js[key], b = wa[key];
    if (a.length !== b.length) return false;
    for (let i=0;i<a.length;i++) if (a[i] !== b[i]) return false;
  }
  for (let z=0; z<js.trees.length; z++) {
    const a=js.trees[z], b=wa.trees[z];
    if (a.length !== b.length) return false;
    for (let i=0;i<a.length;i++) if (a[i] !== b[i]) return false;
  }
  return true;
}

function measure(fn, runs) {
  const values=[];
  for (let i=0;i<runs;i++) {
    gc();
    const t0=performance.now();
    const value=fn();
    values.push(performance.now()-t0);
    if (!value) throw new Error("benchmark function returned null");
  }
  return { median: median(values), p95: p95(values), values };
}

console.log(`Orihon Cluster-WASM P2 memory benchmark · Node ${process.version} · ${process.platform}/${process.arch}`);
console.log(`COUNT=${fmt(COUNT)} · maxZoom=${MAX_ZOOM} · runs=${RUNS} · WASM=${clusterIndexWasmSupported()} · --expose-gc=${Boolean(global.gc)}`);
if (!clusterIndexWasmSupported()) throw new Error(clusterIndexWasmError());

for (const kind of ["dense", "regional", "global"]) {
  console.log(`\n=== ${kind} ===`);
  console.log(`semantic check (${fmt(SAMPLE)}): ${semantic(kind) ? "PASS" : "FAIL"}`);
  const coords = makeCoords(COUNT, kind);
  const input = inputFor(coords);

  // Warm each path once so module load/memory reservation/JIT do not dominate medians.
  buildClusterIndexWasmUnsafe(coords, input);
  gc();
  buildClusterIndex(coords.length > 400_000 && COUNT >= 1_000_000 ? { ...input, coords: coords.subarray(0, 400_000) } : input);
  gc();

  const js = measure(() => buildClusterIndex(input), RUNS);
  const snapshot = measure(() => buildClusterIndexWasm(coords, input), RUNS);
  const unsafe = measure(() => buildClusterIndexWasmUnsafe(coords, input), RUNS);

  console.log(`JS hierarchy          ${js.median.toFixed(3)}ms median · ${js.p95.toFixed(3)}ms p95`);
  console.log(`WASM snapshot         ${snapshot.median.toFixed(3)}ms median · ${snapshot.p95.toFixed(3)}ms p95`);
  console.log(`WASM unsafe           ${unsafe.median.toFixed(3)}ms median · ${unsafe.p95.toFixed(3)}ms p95`);
  console.log(`speedup snapshot vs JS ${(js.median / snapshot.median).toFixed(2)}x`);
  console.log(`snapshot tax           ${(snapshot.median - unsafe.median).toFixed(3)}ms median delta`);

  gc();
  const profile = {};
  const profiled = buildClusterIndexWasm(coords, { ...input, __clusterIndexWasmProfile: profile });
  if (!profiled) throw new Error(clusterIndexWasmError());
  console.log("snapshot profile:");
  console.log(`  leaves / nodes       ${fmt(profile.leafCount ?? COUNT)} / ${fmt(profile.nodeCount)}`);
  console.log(`  tree entries         ${fmt(profile.treeEntries)}`);
  console.log(`  input                ${mb(profile.inputBytes)}`);
  console.log(`  fixed scratch        ${mb(profile.scratchBytes)}`);
  console.log(`    permanent nodes    ${mb(profile.permanentBytes)}`);
  console.log(`    transient/reused   ${mb(profile.transientBytes)}`);
  console.log(`  actual tree scratch  ${mb(profile.treeScratchBytes)}`);
  console.log(`  output blob          ${mb(profile.outputBytes)}`);
  console.log(`  P1 output max reserve ${mb(profile.outputCapacityBytes)}`);
  console.log(`  active linear peak   ${mb(profile.activeLinearBytes)}`);
  console.log(`  WASM memory pages    ${mb(profile.wasmMemoryBytes)}`);
  console.log(`  kernel grown pages   ${fmt(profile.kernelGrowPages)}`);
  console.log(`  memory/grow          ${Number(profile.memoryGrowMs).toFixed(3)}ms`);
  console.log(`  JS → WASM coords     ${Number(profile.inputCopyMs).toFixed(3)}ms`);
  console.log(`  WASM whole index     ${Number(profile.wasmBuildMs).toFixed(3)}ms`);
  console.log(`  WASM → snapshot      ${Number(profile.snapshotMs).toFixed(3)}ms`);
  console.log(`  typed-array views    ${Number(profile.viewsMs).toFixed(3)}ms`);
  console.log(`  total profiled       ${Number(profile.totalMs).toFixed(3)}ms`);
}
