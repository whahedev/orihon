import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const kib = 1024;

/**
 * One ceiling advertised for the whole engine. Every shipped artifact must fit
 * under it, and the README may not claim a different number — the check below
 * enforces both, so the headline figure can never drift from the build again.
 */
const HEADLINE_CEILING_KIB = 150;

/**
 * Per-artifact gzip budgets. Keep roughly 5-10% headroom over the current build:
 * a budget with no slack turns every unrelated PR into a size incident, and one
 * with too much slack stops catching regressions.
 */
const budgets = {
  "orihon.core.esm.js": 18 * kib,
  // Includes async GeoJSON ingestion plus incremental FeatureSource sync on GeoJSONLayer.
  "orihon.standard.esm.js": 38 * kib,
  // Advanced includes whole-index clustering/MVT WASM, unified WASM heat fields,
  // WebGL scene renderers, async mass ingestion and lazy WebGPU compute/tiles.
  "orihon.esm.js": 132 * kib,
  // React bindings re-export the Advanced surface, so they track `orihon.esm.js`.
  "orihon.react.esm.js": 118 * kib,
  // Script-tag build: no code splitting, so it carries the lazy chunks inline.
  "orihon.global.js": 149 * kib,
  "orihon.draw.esm.js": 12 * kib,
  "orihon.controls.esm.js": 8 * kib,
  "orihon.geo.esm.js": 2 * kib,
  "orihon.popup-content.esm.js": 5 * kib
};

const manifest = JSON.parse(await readFile(new URL("../dist/release-manifest.json", import.meta.url), "utf8"));

const failures = [];
for (const [file, budget] of Object.entries(budgets)) {
  const actual = manifest.sizes?.[file]?.gzipBytes;
  assert.equal(typeof actual, "number", `Missing gzip size for ${file}`);
  if (actual > budget) {
    failures.push(`${file}: ${(actual / kib).toFixed(2)} KiB gzip exceeds its ${(budget / kib).toFixed(0)} KiB budget`);
  }
  if (actual > HEADLINE_CEILING_KIB * kib) {
    failures.push(`${file}: ${(actual / kib).toFixed(2)} KiB gzip breaks the advertised ${HEADLINE_CEILING_KIB} KiB ceiling`);
  }
}

// Optional `orihon/source` stays a lean tsc ESM module (no browser rollup artifact).
const sourceJs = await readFile(new URL("../dist/feature-source.js", import.meta.url));
const sourceGzip = gzipSync(sourceJs, { level: 9 }).length;
const sourceBudget = 5 * kib;
if (sourceGzip > sourceBudget) {
  failures.push(`feature-source.js: ${(sourceGzip / kib).toFixed(2)} KiB gzip exceeds ${(sourceBudget / kib).toFixed(0)} KiB`);
}

/**
 * The README is a published size claim, so it is verified like any other build
 * output: its budget table and its headline number must match this file.
 */
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

const headlineMentions = [...readme.matchAll(/(\d+)\s*KiB\s*gzip/gi)].map((match) => Number(match[1]));
const badgeMentions = [...readme.matchAll(/badge\/[^)\s]*?(\d+)_KiB_gzip/gi)].map((match) => Number(match[1]));
for (const claimed of [...headlineMentions, ...badgeMentions]) {
  if (claimed < HEADLINE_CEILING_KIB && !Object.values(budgets).some((budget) => budget / kib === claimed)) {
    failures.push(`README claims "${claimed} KiB gzip", which matches neither a per-artifact budget nor the ${HEADLINE_CEILING_KIB} KiB ceiling`);
  }
}

const tableRows = [...readme.matchAll(/^\|\s*`(orihon[^`]+)`\s*\|\s*≤\s*(\d+)\s*KiB gzip/gm)];
assert.ok(tableRows.length > 0, "README is missing the artifact budget table");
for (const [, file, claimed] of tableRows) {
  const budget = budgets[file];
  if (budget === undefined) {
    failures.push(`README lists \`${file}\`, which has no budget in scripts/check-size.mjs`);
  } else if (budget / kib !== Number(claimed)) {
    failures.push(`README says \`${file}\` ≤ ${claimed} KiB, the enforced budget is ${(budget / kib).toFixed(0)} KiB`);
  }
}
for (const file of Object.keys(budgets)) {
  if (!tableRows.some(([, listed]) => listed === file)) {
    failures.push(`README budget table is missing \`${file}\``);
  }
}

if (failures.length) {
  console.error(failures.map((line) => `  - ${line}`).join("\n"));
  throw new Error(`${failures.length} size check failure(s)`);
}

const report = Object.entries(manifest.sizes)
  .map(([file, size]) => {
    const budget = budgets[file];
    const suffix = budget ? ` (budget ${(budget / kib).toFixed(0)} KiB)` : "";
    return `${file}: ${(size.gzipBytes / kib).toFixed(2)} KiB gzip${suffix}`;
  })
  .join("\n");
console.log(report);
console.log(`feature-source.js: ${(sourceGzip / kib).toFixed(2)} KiB gzip (budget 5 KiB)`);
console.log(`\nAll artifacts under the advertised ${HEADLINE_CEILING_KIB} KiB gzip ceiling.`);
