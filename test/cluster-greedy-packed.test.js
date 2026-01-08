import test from "node:test";
import assert from "node:assert/strict";
import { buildGreedyClusterLayout } from "../dist/services/cluster-layout.js";

function request(count, simple = false) {
  const ids = Array.from({ length: count }, (_, i) => i);
  const coords = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 1000);
    const col = i - row * 1000;
    coords[i * 2] = 45 + row * 0.0005;
    coords[i * 2 + 1] = -120 + col * 0.0005;
  }
  return {
    ids,
    coords,
    zoomBucket: 8,
    gridSize: 50,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 8,
    clusterMinZoom: 0,
    simple
  };
}

function sparseRequest(count) {
  const input = request(count);
  let state = 0x12345678;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = 0; i < count; i++) {
    input.coords[i * 2] = -70 + random() * 140;
    input.coords[i * 2 + 1] = -180 + random() * 360;
  }
  return input;
}

function membershipSignature(result) {
  const groups = [];
  for (const cluster of result.clusters) {
    const ids = cluster.ids.slice().sort((a, b) => a - b);
    groups.push(`c:${ids.join(",")}`);
  }
  for (const single of result.singles) groups.push(`s:${single.id}`);
  groups.sort();
  return groups;
}

test("packed greedy clustering preserves every id exactly once", () => {
  const input = request(10_000);
  const before = input.coords.slice();
  const result = buildGreedyClusterLayout(input);
  const seen = [];
  for (const cluster of result.clusters) seen.push(...cluster.ids);
  for (const single of result.singles) seen.push(single.id);
  seen.sort((a, b) => a - b);
  assert.deepEqual(seen, input.ids);
  assert.deepEqual(input.coords, before);
});

test("worker-format greedy request returns leaf indices when ids are omitted", () => {
  const input = request(32);
  const result = buildGreedyClusterLayout({ ...input, ids: [] });
  const seen = [];
  for (const cluster of result.clusters) seen.push(...cluster.ids);
  for (const single of result.singles) seen.push(single.id);
  seen.sort((a, b) => a - b);
  assert.deepEqual(seen, Array.from({ length: 32 }, (_, i) => i));
});

test("dense Web-Mercator data uses adaptive direct lookup without allocating packed grid", () => {
  const profile = {};
  const input = request(10_000);
  const result = buildGreedyClusterLayout({ ...input, __greedyDirectThreshold: 8, __greedyProfile: profile });
  assert.equal(profile.packedGrid, true);
  assert.equal(profile.adaptiveDirect, true);
  assert.equal(profile.fusedProjection, true);
  assert.equal(profile.count, 10_000);
  assert.equal(profile.directQueries, 10_000);
  assert.equal(profile.gridQueries, 0);
  assert.equal(profile.packedGridAllocated, false);
  assert.equal(profile.tempProjectedBytes, 0);
  assert.ok(profile.insertedOrigins > 0);
  assert.ok(profile.scanMs >= 0);
  assert.ok(result.clusters.length + result.singles.length > 0);
});

test("sparse Web-Mercator data stays on proven packed-grid path", () => {
  const profile = {};
  const input = sparseRequest(10_000);
  buildGreedyClusterLayout({ ...input, __greedyDirectThreshold: 8, __greedyProfile: profile });
  assert.equal(profile.packedGrid, true);
  assert.equal(profile.adaptiveDirect, false);
  assert.equal(profile.fusedProjection, false);
  assert.equal(profile.directQueries, 0);
  assert.equal(profile.gridQueries, 10_000);
  assert.equal(profile.packedGridAllocated, true);
  assert.equal(profile.tempProjectedBytes, 10_000 * 16);
});

test("adaptive direct lookup preserves grid-only memberships", () => {
  const input = request(12_000);
  const gridOnly = buildGreedyClusterLayout({ ...input, __greedyDirectThreshold: 0 });
  const adaptive = buildGreedyClusterLayout({ ...input, __greedyDirectThreshold: 8 });
  assert.deepEqual(membershipSignature(adaptive), membershipSignature(gridOnly));
});

test("worker-format ids remain leaf indices under adaptive direct lookup", () => {
  const input = request(12_000);
  const gridOnly = buildGreedyClusterLayout({ ...input, ids: [], __greedyDirectThreshold: 0 });
  const adaptive = buildGreedyClusterLayout({ ...input, ids: [], __greedyDirectThreshold: 8 });
  assert.deepEqual(membershipSignature(adaptive), membershipSignature(gridOnly));
});

test("simple CRS keeps legacy DistanceGrid fallback", () => {
  const profile = {};
  const input = request(5_000, true);
  buildGreedyClusterLayout({ ...input, __greedyProfile: profile });
  assert.equal(profile.packedGrid, false);
  assert.equal(profile.adaptiveDirect, false);
});

test("small datasets keep legacy grid to avoid packed-table setup overhead", () => {
  const profile = {};
  const input = request(512);
  buildGreedyClusterLayout({ ...input, __greedyProfile: profile });
  assert.equal(profile.packedGrid, false);
  assert.equal(profile.adaptiveDirect, false);
});
