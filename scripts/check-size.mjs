import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../dist/release-manifest.json", import.meta.url), "utf8"));
const kib = 1024;
const budgets = {
  "orihon.core.esm.js": 22 * kib,
  // Includes async GeoJSON ingestion plus incremental FeatureSource sync on GeoJSONLayer.
  "orihon.standard.esm.js": 37 * kib,
  // Advanced includes whole-index clustering/MVT WASM, unified WASM heat fields,
  // WebGL scene renderers, async mass ingestion and lazy WebGPU compute/tiles.
  "orihon.esm.js": 141 * kib,
  "orihon.draw.esm.js": 12 * kib,
  "orihon.controls.esm.js": 8 * kib,
  "orihon.geo.esm.js": 2 * kib,
  "orihon.popup-content.esm.js": 5 * kib
};

for (const [file, budget] of Object.entries(budgets)) {
  const actual = manifest.sizes?.[file]?.gzipBytes;
  assert.equal(typeof actual, "number", `Missing gzip size for ${file}`);
  assert.ok(actual <= budget, `${file}: ${(actual / kib).toFixed(2)} KiB gzip exceeds ${(budget / kib).toFixed(0)} KiB`);
}

// Optional `orihon/source` stays a lean tsc ESM module (no browser rollup artifact).
const sourceJs = await readFile(new URL("../dist/feature-source.js", import.meta.url));
const sourceGzip = gzipSync(sourceJs, { level: 9 }).length;
const sourceBudget = 5 * kib;
assert.ok(
  sourceGzip <= sourceBudget,
  `feature-source.js: ${(sourceGzip / kib).toFixed(2)} KiB gzip exceeds ${(sourceBudget / kib).toFixed(0)} KiB`
);

console.log(Object.entries(manifest.sizes)
  .map(([file, size]) => `${file}: ${(size.gzipBytes / kib).toFixed(2)} KiB gzip`)
  .join("\n"));
console.log(`feature-source.js: ${(sourceGzip / kib).toFixed(2)} KiB gzip`);
