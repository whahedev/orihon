import { performance } from "node:perf_hooks";

import {
  buildClusterIndex,
  buildGreedyClusterLayout,
  decodeClusterIndex,
  encodeClusterIndex
} from "../dist/services/cluster-layout.js";

const COUNT = Math.max(1, Number(process.env.COUNT) || 100_000);
const HIERARCHY_COUNT = Math.min(COUNT, 250_000);

function fmt(ms) {
  return `${ms.toFixed(ms >= 100 ? 2 : 3)}ms`;
}

function bytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function gc() {
  global.gc?.();
}

function makeInput(count) {
  const ids = Array.from({ length: count }, (_, id) => id);
  const coords = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 1000);
    const col = i - row * 1000;
    coords[i * 2] = 45 + (row % 1000) * 0.0005;
    coords[i * 2 + 1] = -120 + (col % 1000) * 0.0005;
  }
  return { ids, coords };
}

function baseRequest(input, clusterize) {
  return {
    ...input,
    gridSize: 50,
    minPoints: 2,
    clusterize,
    clusterMaxZoom: 8,
    clusterMinZoom: 0
  };
}

function measure(label, fn) {
  gc();
  const t0 = performance.now();
  const value = fn();
  const elapsed = performance.now() - t0;
  console.log(`${label}: ${fmt(elapsed)}`);
  return { value, elapsed };
}

function legacyEncodeCopy(index) {
  const arrays = [
    index.x,
    index.y,
    index.lat,
    index.lng,
    index.weight,
    index.zoom,
    index.parent,
    index.firstChild,
    index.nextSibling,
    ...index.trees
  ];
  let copied = 0;
  const outputs = [];
  for (const array of arrays) {
    const copy = array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength);
    copied += copy.byteLength;
    outputs.push(copy);
  }
  return { copied, outputs };
}

console.log(`Orihon P1-D cluster benchmark · Node ${process.version} · ${process.platform}/${process.arch}`);
console.log(`COUNT=${COUNT.toLocaleString()} · hierarchy=${HIERARCHY_COUNT.toLocaleString()} · --expose-gc=${global.gc ? "yes" : "no"}`);
console.log();

const input = makeInput(COUNT);

const projection = measure("projection/index arrays only (clusterize=false)", () =>
  buildClusterIndex(baseRequest(input, false))
);
console.log(`  leaves=${projection.value.leafCount.toLocaleString()} nodes=${projection.value.nodeCount.toLocaleString()}`);

const greedy = measure("single-zoom greedy clustering", () =>
  buildGreedyClusterLayout({ ...baseRequest(input, true), zoomBucket: 8 })
);
console.log(`  clusters=${greedy.value.clusters.length.toLocaleString()} singles=${greedy.value.singles.length.toLocaleString()}`);

const hierarchyInput = HIERARCHY_COUNT === COUNT
  ? input
  : { ids: input.ids.slice(0, HIERARCHY_COUNT), coords: input.coords.subarray(0, HIERARCHY_COUNT * 2) };

const hierarchy = measure("hierarchy build", () =>
  buildClusterIndex(baseRequest(hierarchyInput, true))
);
console.log(`  leaves=${hierarchy.value.leafCount.toLocaleString()} nodes=${hierarchy.value.nodeCount.toLocaleString()}`);

const oldEncode = measure("legacy output copying (simulated)", () => legacyEncodeCopy(hierarchy.value));
console.log(`  copied=${bytes(oldEncode.value.copied)}`);

const newEncode = measure("P1-D encode metadata (zero-copy)", () => encodeClusterIndex(hierarchy.value));
const transferredBuffers = new Set(newEncode.value.transfer);
let transferBytes = 0;
for (const buffer of transferredBuffers) transferBytes += buffer.byteLength;
console.log(`  transfer buffers=${newEncode.value.transfer.length} ownership=${bytes(transferBytes)} copied-by-encoder=0 B`);

const transferCount = Math.min(COUNT, 100_000);
const transferInput = transferCount === COUNT
  ? makeInput(transferCount)
  : { ids: input.ids.slice(0, transferCount), coords: input.coords.subarray(0, transferCount * 2) };
const transferIndex = buildClusterIndex(baseRequest(transferInput, true));
const encoded = encodeClusterIndex(transferIndex);
const transfer = measure("structuredClone ownership transfer", () =>
  structuredClone(encoded.payload, { transfer: encoded.transfer })
);
const decoded = decodeClusterIndex(transfer.value);
console.log(`  validation leaves=${decoded.leafCount.toLocaleString()} nodes=${decoded.nodeCount.toLocaleString()}`);

console.log();
console.log("Note: GeometryWorkerPool still copies request.coords before transfer to preserve caller ownership.");
console.log("P1-D removes per-point projection objects and worker OUTPUT buffer copies; input ownership is a separate API/design step.");
