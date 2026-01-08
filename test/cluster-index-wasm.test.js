import test from "node:test";
import assert from "node:assert/strict";
import { buildClusterIndex } from "../dist/services/cluster-layout.js";
import {
  buildClusterIndexWasm,
  buildClusterIndexWasmUnsafe,
  clusterIndexWasmSupported,
  decodeClusterIndexWasmBlob
} from "../dist/services/cluster-index-wasm.js";

function coordsFor(count, kind) {
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

function options(coords, extra = {}) {
  return {
    ids: [],
    coords,
    gridSize: 50,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 8,
    clusterMinZoom: 0,
    ...extra
  };
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
  let maxProjectionError = 0;
  for (let i = 0; i < expected.nodeCount; i++) {
    maxProjectionError = Math.max(
      maxProjectionError,
      Math.abs(actual.x[i] - expected.x[i]),
      Math.abs(actual.y[i] - expected.y[i])
    );
    assert.equal(actual.lat[i], expected.lat[i]);
    assert.equal(actual.lng[i], expected.lng[i]);
  }
  assert.ok(maxProjectionError < 1e-8, `projection error ${maxProjectionError}`);
}

test("whole-index WASM is available", () => {
  assert.equal(clusterIndexWasmSupported(), true);
});

for (const kind of ["dense", "regional", "global"]) {
  test(`whole-index WASM matches JS hierarchy (${kind})`, () => {
    const coords = coordsFor(5_000, kind);
    const input = options(coords);
    const js = buildClusterIndex(input);
    const wasm = buildClusterIndexWasm(coords, input);
    assertIndexEquivalent(wasm, js);
    assert.deepEqual(wasm.ids, []);
  });
}

test("simple CRS matches JS hierarchy", () => {
  const coords = coordsFor(2_000, "regional");
  const input = options(coords, { simple: true });
  const js = buildClusterIndex(input);
  const wasm = buildClusterIndexWasm(coords, input);
  assertIndexEquivalent(wasm, js);
});

test("stable WASM snapshot survives later builds", () => {
  const aCoords = coordsFor(4_000, "dense");
  const a = buildClusterIndexWasm(aCoords, options(aCoords));
  assert.ok(a);
  const before = Array.from(a.parent.slice(0, 128));
  const blob = a.x.buffer;
  assert.ok(blob instanceof ArrayBuffer);
  const decoded = decodeClusterIndexWasmBlob(blob);
  assert.ok(decoded);
  assert.equal(decoded.nodeCount, a.nodeCount);
  const bCoords = coordsFor(12_000, "global");
  const b = buildClusterIndexWasm(bCoords, options(bCoords));
  assert.ok(b);
  assert.deepEqual(Array.from(a.parent.slice(0, 128)), before);
});

test("unsafe path shares live WASM memory and is benchmark-only", () => {
  const coords = coordsFor(1_000, "dense");
  const index = buildClusterIndexWasmUnsafe(coords, options(coords));
  assert.ok(index);
  assert.equal(index.leafCount, 1_000);
  assert.deepEqual(index.ids, []);
});

test("P2 reuses transient scratch for the compact output", () => {
  const coords = coordsFor(20_000, "global");
  const profile = {};
  const index = buildClusterIndexWasm(coords, {
    ...options(coords),
    __clusterIndexWasmProfile: profile
  });
  assert.ok(index);
  assert.equal(profile.clusterIndexWasmP2, true);
  assert.ok(Number(profile.permanentBytes) > 0);
  assert.ok(Number(profile.transientBytes) > 0);
  assert.equal(Number(profile.permanentBytes) + Number(profile.transientBytes), Number(profile.scratchBytes));
  assert.ok(Number(profile.activeLinearBytes) < Number(profile.inputBytes) + Number(profile.scratchBytes) + Number(profile.outputCapacityBytes));
});

test("P2 handles an empty index", () => {
  const coords = new Float64Array();
  const input = options(coords);
  const js = buildClusterIndex(input);
  const wasm = buildClusterIndexWasm(coords, input);
  assertIndexEquivalent(wasm, js);
});

test("P2 preserves non-clusterized hierarchy semantics", () => {
  const coords = coordsFor(2_000, "global");
  const input = options(coords, { clusterize: false });
  const js = buildClusterIndex(input);
  const wasm = buildClusterIndexWasm(coords, input);
  assertIndexEquivalent(wasm, js);
});
