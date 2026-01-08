import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { clusterIndexWasmWorkerAddonSource } from "../dist/services/cluster-index-wasm.js";

const COUNT = Math.max(1, Number(process.env.COUNT) || 1_000_000);
const RUNS = Math.max(1, Number(process.env.RUNS) || 5);
const MAX_ZOOM = Math.max(0, Number(process.env.MAX_ZOOM) || 8);
const DISTRIBUTION = ["dense", "regional", "global"].includes(process.env.DISTRIBUTION)
  ? process.env.DISTRIBUTION
  : "dense";

function makeCoords(count, kind) {
  const out = new Float64Array(count * 2);
  let state = 0x12345678;
  const rnd = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
  for (let i = 0; i < count; i++) {
    if (kind === "dense") {
      out[i * 2] = 55.75 + (rnd() - 0.5) * 0.3;
      out[i * 2 + 1] = 37.62 + (rnd() - 0.5) * 0.5;
    } else if (kind === "regional") {
      out[i * 2] = 45 + rnd() * 20;
      out[i * 2 + 1] = 20 + rnd() * 40;
    } else {
      out[i * 2] = -80 + rnd() * 160;
      out[i * 2 + 1] = -180 + rnd() * 360;
    }
  }
  return out;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function fmtMs(v) { return `${v.toFixed(3)}ms`; }
function mb(v) { return `${(v / 1024 / 1024).toFixed(1)}MB`; }

function createHarness() {
  const messages = [];
  const context = vm.createContext({
    WebAssembly,
    atob,
    Float64Array,
    Float32Array,
    Uint8Array,
    ArrayBuffer,
    Math,
    Number,
    JSON,
    Object,
    console,
    onmessage: () => {},
    postMessage: (message) => messages.push(message)
  });
  vm.runInContext(clusterIndexWasmWorkerAddonSource(), context);
  return { context, messages };
}

function buildMessage(id, type, extra = {}) {
  return {
    id,
    type,
    gridSize: 50,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: MAX_ZOOM,
    clusterMinZoom: 0,
    simple: false,
    ...extra
  };
}

const coords = makeCoords(COUNT, DISTRIBUTION);
console.log(`Orihon Cluster-WASM P3 persistent-dataset benchmark · Node ${process.version} · ${process.platform}/${process.arch}`);
console.log(`COUNT=${COUNT.toLocaleString()} · distribution=${DISTRIBUTION} · maxZoom=${MAX_ZOOM} · runs=${RUNS} · coords=${mb(coords.byteLength)} · --expose-gc=${global.gc ? "yes" : "no"}`);

// Warm separate states so both modes compare with already-grown WebAssembly.Memory.
{
  const h = createHarness();
  h.context.onmessage({ data: buildMessage(1, "clusterIndex", { coords }) });
}
{
  const h = createHarness();
  h.context.onmessage({ data: { id: 1, type: "clusterDatasetInstall", datasetId: 1, coords } });
  h.messages.length = 0;
  h.context.onmessage({ data: buildMessage(2, "clusterIndexDataset", { datasetId: 1 }) });
}

const legacy = createHarness();
legacy.context.onmessage({ data: buildMessage(1, "clusterIndex", { coords }) });
legacy.messages.length = 0;
const legacyTimes = [];
for (let i = 0; i < RUNS; i++) {
  global.gc?.();
  const t0 = performance.now();
  const copy = coords.slice();
  legacy.context.onmessage({ data: buildMessage(10 + i, "clusterIndex", { coords: copy }) });
  legacyTimes.push(performance.now() - t0);
  legacy.messages.length = 0;
}

const persistent = createHarness();
global.gc?.();
let t0 = performance.now();
const installCopy = coords.slice();
persistent.context.onmessage({ data: { id: 100, type: "clusterDatasetInstall", datasetId: 7, coords: installCopy } });
const installMs = performance.now() - t0;
const ready = persistent.messages.at(-1);
if (!ready?.ok) throw new Error("persistent dataset install failed");
persistent.messages.length = 0;
// Warm the same persistent WASM instance before measuring, matching the legacy arm.
persistent.context.onmessage({ data: buildMessage(101, "clusterIndexDataset", { datasetId: 7 }) });
persistent.messages.length = 0;
const persistentTimes = [];
for (let i = 0; i < RUNS; i++) {
  global.gc?.();
  const t1 = performance.now();
  persistent.context.onmessage({ data: buildMessage(200 + i, "clusterIndexDataset", { datasetId: 7 }) });
  persistentTimes.push(performance.now() - t1);
  const result = persistent.messages.at(-1);
  if (result?.type !== "clusterIndexWasm" || result.inputReused !== true) {
    throw new Error("persistent rebuild did not reuse input");
  }
  persistent.messages.length = 0;
}

const legacyMedian = median(legacyTimes);
const persistentMedian = median(persistentTimes);
console.log(`legacy rebuild (slice + transfer-model + WASM input copy)  ${fmtMs(legacyMedian)} median`);
console.log(`persistent dataset install (one-time)                    ${fmtMs(installMs)}`);
console.log(`persistent rebuild (datasetId only)                      ${fmtMs(persistentMedian)} median`);
console.log(`rebuild delta                                             ${fmtMs(legacyMedian - persistentMedian)}`);
console.log(`speedup                                                   ${(legacyMedian / persistentMedian).toFixed(2)}x`);
console.log(`coord bytes avoided per reuse                             ${mb(coords.byteLength)}`);
console.log(`break-even reuses                                         ${Math.max(1, Math.ceil(installMs / Math.max(0.001, legacyMedian - persistentMedian)))}`);
