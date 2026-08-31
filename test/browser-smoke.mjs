import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const mod = await import("../dist/full-entry.js");
const browserObjectManagers = await import("../dist/orihon.object-manager.esm.js");
const globalLoader = await readFile(new URL("../dist/orihon.global.js", import.meta.url), "utf8");
const coreLoader = await readFile(new URL("../dist/orihon.core.esm.js", import.meta.url), "utf8");
const standardLoader = await readFile(new URL("../dist/orihon.standard.esm.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../dist/release-manifest.json", import.meta.url), "utf8"));

assert.equal(typeof mod.createMap, "function");
assert.equal(typeof mod.decodeMVT, "function");
assert.equal(typeof mod.createMVTProvider, "function");
assert.equal(mod.L, undefined);
assert.equal(mod.leaflet, undefined);
assert.doesNotMatch(globalLoader, /import\s*\(/);
assert.match(coreLoader, /import\(["']\.\/services\/map-export\.js["']\)/);
assert.match(standardLoader, /import\(["']\.\/orihon-map-export-[^"']+\.js["']\)/);
assert.match(standardLoader, /import\(["']\.\/orihon-locale-packs-[^"']+\.js["']\)/);
assert.match(coreLoader, /import\(["']\.\/ui\/locale-packs\.js["']\)/);
assert.doesNotMatch(coreLoader, /\\u0418\\u043D\\u0442\\u0435\\u0440\\u0430\\u043A\\u0442\\u0438\\u0432\\u043D\\u0430\\u044F/);
assert.doesNotMatch(coreLoader, /PNG export failed/);
assert.doesNotMatch(standardLoader, /PNG export failed/);
assert.doesNotMatch(globalLoader, /OrihonL/);
const advancedLoader = await readFile(new URL("../dist/orihon.esm.js", import.meta.url), "utf8");
assert.match(advancedLoader, /import\(/);
assert.ok(manifest.initialLoads["orihon.standard.esm.js"].files.length > 1);
assert.ok(manifest.initialLoads["orihon.esm.js"].files.length > 1);
if (Array.isArray(manifest.chunks)) {
  for (const chunk of manifest.chunks) {
    assert.equal(typeof manifest.sizes?.[chunk]?.gzipBytes, "number", `missing size for ${chunk}`);
  }
}
const context = {
  Promise,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  DataView
};
context.globalThis = context;
vm.runInNewContext(globalLoader, context);
assert.equal(typeof context.Orihon.createMap, "function");
assert.equal(typeof context.Orihon.tileLayer, "function");
assert.equal(typeof context.Orihon.GPUTileLayer, "function");
assert.equal("objectManager" in context.Orihon, false);
assert.equal(context.OrihonL, undefined);
const browserManager = browserObjectManagers.objectManager();
assert.equal(browserManager.isDestroyed, false, "minification must preserve boolean getters");
browserManager.destroy();
assert.equal(browserManager.isDestroyed, true);
assert.equal(typeof context.OrihonReady?.then, "function");
assert.equal(manifest.global, "orihon.global.js");
assert.equal(typeof manifest.sizes["orihon.global.js"].gzipBytes, "number");

console.log("browser artifact smoke ok");
