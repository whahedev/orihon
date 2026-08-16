/**
 * ObjectManager ingest / update stress (Node, no WebGL paint).
 * Run: node scripts/bench-object-manager-scene.mjs
 * Optional: COUNT=1000000 node scripts/bench-object-manager-scene.mjs
 *
 * Answers the “does 1M fit?” question for CPU/RAM of the manager store + indexes.
 * Browser paint of 1M is WebGL flat points (clusters OFF) — use the scene lab Stress buttons.
 */
import { performance } from "node:perf_hooks";
import { objectManager } from "../dist/services/object-manager.js";
import { ObjectSceneController } from "../dist/services/object-scene.js";

function ms(label, fn) {
  const t0 = performance.now();
  const result = fn();
  const elapsed = performance.now() - t0;
  console.log(`${label}: ${elapsed.toFixed(2)}ms`);
  return { elapsed, result };
}

async function msAsync(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  const elapsed = performance.now() - t0;
  console.log(`${label}: ${elapsed.toFixed(2)}ms`);
  return { elapsed, result };
}

function heapMb() {
  const { heapUsed } = process.memoryUsage();
  return (heapUsed / (1024 * 1024)).toFixed(1);
}

const N = Math.max(1_000, Number(process.env.COUNT) || 100_000);
const CHUNK = N >= 1_000_000 ? 25_000 : 10_000;
const useClusters = N <= 250_000;

console.log(`\nObjectManager stress · N=${N.toLocaleString("en-US")} · clusters=${useClusters ? "on" : "off"}`);
console.log("(no WebGL — ingest / layout / updates only)\n");

const manager = objectManager({
  clusterize: useClusters,
  clusterGridSize: 55,
  clusterRenderer: "auto",
  webglThreshold: 20,
  declutter: false,
  sceneFeatures: false,
  styleByCategory: false,
  visualization: useClusters ? "auto" : "objects"
});

await msAsync(`ingest ${N.toLocaleString("en-US")} points (chunk ${CHUNK})`, async () => {
  manager.beginBulk();
  let added = 0;
  while (added < N) {
    const n = Math.min(CHUNK, N - added);
    const batch = new Array(n);
    for (let i = 0; i < n; i++) {
      const id = added + i;
      const u = ((id * 2654435761) >>> 0) / 4294967296;
      const v = ((id * 1597334677) >>> 0) / 4294967296;
      batch[i] = {
        id,
        coordinates: [35 + u * 28, -15 + v * 55],
        properties: { alert: id % 97 === 0 }
      };
    }
    manager.add(batch);
    added += n;
    if (added % (CHUNK * 4) === 0 || added === N) {
      await new Promise((r) => setImmediate(r));
    }
  }
  manager.endBulk({ render: false });
});
console.log(`  heap after ingest: ${heapMb()} MB`);

await msAsync("prepareLayout (flat or greedy)", async () => {
  await manager.prepareLayout(useClusters ? 8 : 6);
});
console.log(`  stats:`, manager.getStats());
console.log(`  heap after layout: ${heapMb()} MB`);

ms("5k position updates (batch)", () => {
  const updates = [];
  const limit = Math.min(5000, N);
  for (let i = 0; i < limit; i++) {
    const prev = manager.getObject(i);
    updates.push({
      id: i,
      coordinates: [55.1 + (i % 100) * 0.001, 37.1],
      properties: prev?.properties
    });
  }
  manager.updateObjects(updates);
});

ms("1k state patches", () => {
  const updates = [];
  const limit = Math.min(1000, N);
  for (let i = 0; i < limit; i++) updates.push({ id: i, state: { alarm: i % 2 === 0 } });
  manager.setObjectStates(updates);
});

// Optional search/time microbench on a smaller dedicated manager
const searchN = Math.min(N, 100_000);
const searchManager = objectManager({
  search: { fields: ["properties.name"] },
  time: { value: (o) => Number(o.properties?.timestamp ?? 0) }
});
ms(`search-index ingest ${searchN.toLocaleString("en-US")}`, () => {
  const batch = [];
  for (let i = 0; i < searchN; i++) {
    batch.push({
      id: i,
      coordinates: [55 + (i % 1000) * 0.001, 37 + ((i / 1000) | 0) * 0.001],
      properties: { name: `obj-${i}`, timestamp: i }
    });
    if (batch.length === 5000) {
      searchManager.add(batch);
      batch.length = 0;
    }
  }
  if (batch.length) searchManager.add(batch);
});
ms("search prefix", () => searchManager.search("obj-42", { limit: 20 }).length);
ms("temporal range query (scene index)", () => {
  const scene = new ObjectSceneController();
  scene.configure({
    time: { value: (o) => Number(o.properties?.timestamp ?? 0) }
  });
  for (let i = 0; i < searchN; i++) scene.timeIndex.upsert(i, { properties: { timestamp: i } });
  scene.setTimeRange(10_000, 20_000);
  return scene.activeTimeIds()?.size ?? 0;
});

ms("10k motion starts", () => {
  const scene = new ObjectSceneController();
  for (let i = 0; i < 10_000; i++) {
    scene.startMotion(i, 0, 0, 1, 1, 800);
  }
  return scene.motions.size;
});

console.log("\nVerdict:");
console.log(
  N >= 1_000_000
    ? "  1M store+layout: OK in Node if heap stays reasonable; browser paint needs clusters OFF + bare WebGL points (no icons/labels/trails)."
    : "  Scale further with COUNT=1000000. Browser: examples/object-manager-scene Stress 1M."
);
console.log(`  objects: ${manager.getStats().objects} · heap ${heapMb()} MB\n`);

searchManager.destroy();
manager.destroy();
