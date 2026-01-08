import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { buildClusterIndex } from "../dist/services/cluster-layout.js";
import {
  clusterIndexWasmWorkerAddonSource,
  decodeClusterIndexWasmBlob
} from "../dist/services/cluster-index-wasm.js";

function coordsFor(count) {
  const coords = new Float64Array(count * 2);
  let state = 0x2f6e2b1;
  const rnd = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
  for (let i = 0; i < count; i++) {
    coords[i * 2] = 45 + rnd() * 20;
    coords[i * 2 + 1] = 20 + rnd() * 40;
  }
  return coords;
}

function assertIndexEquivalent(actual, expected) {
  assert.ok(actual);
  for (const key of ["leafCount", "nodeCount", "maxZoom", "minZoom", "minPoints", "radius"]) {
    assert.equal(actual[key], expected[key], key);
  }
  for (const key of ["weight", "zoom", "parent", "firstChild", "nextSibling"]) {
    assert.deepEqual(actual[key], expected[key], key);
  }
  assert.equal(actual.trees.length, expected.trees.length);
  for (let z = 0; z < expected.trees.length; z++) {
    assert.deepEqual(actual.trees[z], expected.trees[z], `tree z=${z}`);
  }
}

test("worker addon intercepts clusterIndex and emits transferable WASM blob", () => {
  const messages = [];
  let fallbackCalls = 0;
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
    onmessage: () => { fallbackCalls += 1; },
    postMessage: (message) => messages.push(message)
  });
  vm.runInContext(clusterIndexWasmWorkerAddonSource(), context);

  const coords = coordsFor(5_000);
  context.onmessage({
    data: {
      id: 42,
      type: "clusterIndex",
      coords,
      gridSize: 50,
      minPoints: 2,
      clusterize: true,
      clusterMaxZoom: 8,
      clusterMinZoom: 0,
      simple: false
    }
  });

  assert.equal(fallbackCalls, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "clusterIndexWasm");
  assert.ok(messages[0].blob instanceof ArrayBuffer);
  assert.ok(messages[0].wasmMemoryBytes > 0);
  assert.ok(messages[0].outputBytes > 0);
  assert.ok(messages[0].permanentBytes > 0);
  assert.ok(messages[0].transientBytes > 0);
  assert.ok(messages[0].activeLinearBytes > 0);

  const wasm = decodeClusterIndexWasmBlob(messages[0].blob);
  const js = buildClusterIndex({
    ids: [],
    coords,
    gridSize: 50,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 8,
    clusterMinZoom: 0
  });
  assertIndexEquivalent(wasm, js);
});

test("worker addon delegates unrelated messages to the original worker handler", () => {
  let fallbackCalls = 0;
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
    onmessage: () => { fallbackCalls += 1; },
    postMessage: () => {}
  });
  vm.runInContext(clusterIndexWasmWorkerAddonSource(), context);
  context.onmessage({ data: { id: 7, type: "preparePoints", points: [] } });
  assert.equal(fallbackCalls, 1);
});

test("worker addon installs one persistent dataset and reuses it for clusterIndex", () => {
  const messages = [];
  let fallbackCalls = 0;
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
    onmessage: () => { fallbackCalls += 1; },
    postMessage: (message) => messages.push(message)
  });
  vm.runInContext(clusterIndexWasmWorkerAddonSource(), context);

  const coords = coordsFor(10_000);
  context.onmessage({ data: { id: 1, type: "clusterDatasetInstall", datasetId: 77, coords } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "clusterDatasetReady");
  assert.equal(messages[0].ok, true);
  assert.equal(messages[0].datasetId, 77);
  assert.equal(messages[0].count, 10_000);
  messages.length = 0;

  context.onmessage({
    data: {
      id: 2,
      type: "clusterIndexDataset",
      datasetId: 77,
      gridSize: 50,
      minPoints: 2,
      clusterize: true,
      clusterMaxZoom: 8,
      clusterMinZoom: 0,
      simple: false
    }
  });

  assert.equal(fallbackCalls, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "clusterIndexWasm");
  assert.equal(messages[0].inputReused, true);
  assert.equal(messages[0].inputBytes, coords.byteLength);
  const wasm = decodeClusterIndexWasmBlob(messages[0].blob);
  const js = buildClusterIndex({
    ids: [],
    coords,
    gridSize: 50,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 8,
    clusterMinZoom: 0
  });
  assertIndexEquivalent(wasm, js);
});

test("persistent dataset can back greedy worker requests without retransferring coords", () => {
  const messages = [];
  const delegated = [];
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
    onmessage: (event) => delegated.push(event),
    postMessage: (message) => messages.push(message)
  });
  vm.runInContext(clusterIndexWasmWorkerAddonSource(), context);

  const coords = coordsFor(1_000);
  context.onmessage({ data: { id: 11, type: "clusterDatasetInstall", datasetId: 5, coords } });
  assert.equal(messages[0].ok, true);
  messages.length = 0;

  context.onmessage({
    data: {
      id: 12,
      type: "greedyClusterLayoutDataset",
      datasetId: 5,
      zoomBucket: 8,
      gridSize: 50,
      minPoints: 2,
      clusterize: true,
      clusterMaxZoom: 8,
      clusterMinZoom: 0,
      simple: false
    }
  });
  assert.equal(messages.length, 0);
  assert.equal(delegated.length, 1);
  assert.equal(delegated[0].data.type, "greedyClusterLayout");
  assert.ok(delegated[0].data.coords instanceof Float64Array);
  assert.equal(delegated[0].data.coords.length, coords.length);
  assert.deepEqual(delegated[0].data.coords.slice(0, 16), coords.slice(0, 16));
});

test("stale dataset ids fail closed so the pool can retry through the legacy path", () => {
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
  context.onmessage({ data: { id: 99, type: "clusterIndexDataset", datasetId: 404 } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "clusterDatasetMissing");
  assert.equal(messages[0].datasetId, 404);
});
