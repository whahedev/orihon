import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("the modular package defaults to Standard and keeps heavy surfaces explicit", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

  assert.equal(pkg.main, "./dist/standard.js");
  assert.deepEqual(pkg.exports["."], {
    types: "./dist/standard.d.ts",
    import: "./dist/standard.js"
  });
  for (const entry of ["./advanced", "./object-manager", "./locales", "./full", "./react/object-manager"]) {
    assert.ok(pkg.exports[entry], `missing explicit package entry ${entry}`);
  }

  assert.ok(pkg.files.includes("!dist/**/*.map"));
  assert.ok(pkg.files.includes("!dist/orihon*.js"));
  assert.equal(pkg.files.includes("assets/brand/png"), false);
  assert.equal(pkg.scripts.prepack, "npm run build");
  assert.match(pkg.scripts.stage, /prepare-publish\.mjs[\s\S]*pack-dist\.mjs/);
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /strip-publish-maps/);
});

test("browser size accounting follows the complete static import closure", async () => {
  const manifest = JSON.parse(await readFile(new URL("dist/release-manifest.json", root), "utf8"));
  for (const file of [
    "orihon.standard.esm.js",
    "orihon.esm.js",
    "orihon.object-manager.esm.js",
    "orihon.locales.esm.js",
    "orihon.react.esm.js",
    "orihon.react-object-manager.esm.js"
  ]) {
    assert.equal(typeof manifest.sizes[file]?.gzipBytes, "number", `${file} has no own size`);
    assert.equal(typeof manifest.initialLoads[file]?.gzipBytes, "number", `${file} has no initial-load size`);
    assert.ok(manifest.initialLoads[file].files.includes(file));
  }
});
