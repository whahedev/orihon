import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../dist/release-manifest.json", import.meta.url), "utf8"));
const kib = 1024;
const budgets = {
  "orihon.core.esm.js": 22 * kib,
  "orihon.standard.esm.js": 35 * kib,
  // Advanced includes WebGL tiles/points/heat/paths, ObjectManager scene,
  // MLT sniff, WASM MVT geometry, WebGPU raster tiles, and shared camera warps.
  "orihon.esm.js": 102 * kib,
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

console.log(Object.entries(manifest.sizes)
  .map(([file, size]) => `${file}: ${(size.gzipBytes / kib).toFixed(2)} KiB gzip`)
  .join("\n"));
