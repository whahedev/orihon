import test from "node:test";
import assert from "node:assert/strict";

import {
  buildClusterIndex,
  decodeClusterIndex,
  encodeClusterIndex
} from "../dist/services/cluster-layout.js";

function request(count, clusterize = true) {
  const ids = Array.from({ length: count }, (_, id) => id);
  const coords = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    coords[i * 2] = 50 + (i % 100) * 0.001;
    coords[i * 2 + 1] = 30 + Math.floor(i / 100) * 0.001;
  }
  return {
    ids,
    coords,
    gridSize: 50,
    minPoints: 2,
    clusterize,
    clusterMaxZoom: 8,
    clusterMinZoom: 0
  };
}

test("cluster index encoding transfers existing buffers without output copies", () => {
  const index = buildClusterIndex(request(256, true));
  const x0 = index.x[0];
  const y0 = index.y[0];
  const nodeCount = index.nodeCount;
  const originalXBuffer = index.x.buffer;

  const encoded = encodeClusterIndex(index);
  const x = encoded.payload.x;

  assert.equal(x.buffer, originalXBuffer);
  assert.equal(x.byteOffset, index.x.byteOffset);
  assert.equal(x.length, index.x.length);
  assert.equal(new Set(encoded.transfer).size, encoded.transfer.length);

  const cloned = structuredClone(encoded.payload, { transfer: encoded.transfer });
  assert.equal(originalXBuffer.byteLength, 0);

  const decoded = decodeClusterIndex(cloned);
  assert.equal(decoded.nodeCount, nodeCount);
  assert.equal(decoded.x.length, nodeCount);
  assert.equal(decoded.y.length, nodeCount);
  assert.ok(Math.abs(decoded.x[0] - x0) < 1e-12);
  assert.ok(Math.abs(decoded.y[0] - y0) < 1e-12);
});

test("cluster index transfer list deduplicates shared tree buffers", () => {
  const index = buildClusterIndex(request(64, false));
  const encoded = encodeClusterIndex(index);

  assert.equal(new Set(encoded.transfer).size, encoded.transfer.length);
  assert.ok(index.trees.length > 1);
  assert.equal(index.trees[0].buffer, index.trees[1].buffer);

  const cloned = structuredClone(encoded.payload, { transfer: encoded.transfer });
  const decoded = decodeClusterIndex(cloned);
  assert.equal(decoded.leafCount, 64);
  assert.equal(decoded.x.length, 64);
});
