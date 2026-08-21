import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("ObjectManager benchmark uses the public built entry and records its environment", async () => {
  const source = await readFile(new URL("scripts/bench-object-manager-scene.mjs", root), "utf8");
  assert.match(source, /from "\.\.\/dist\/index\.js"/);
  assert.doesNotMatch(source, /dist\/services\//);
  assert.doesNotMatch(source, /ObjectSceneController|\.timeIndex|\.motions/);
  assert.match(source, /process\.version/);
  assert.match(source, /process\.platform/);
  assert.match(source, /process\.env\.CLUSTERS/);
  assert.doesNotMatch(source, /N <= 250_000/);
});

test("browser benchmark pins the current package and rebuilds local dist", async () => {
  const [html, packageSource, embedSource, showcase, planetary, aircraft] = await Promise.all([
    readFile(new URL("examples/bench-compare/index.html", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("scripts/embed-examples.mjs", root), "utf8"),
    readFile(new URL("examples/showcase/index.html", root), "utf8"),
    readFile(new URL("examples/planetary-demo/index.html", root), "utf8"),
    readFile(new URL("examples/aircraft-radar-proxy/index.html", root), "utf8")
  ]);
  const pkg = JSON.parse(packageSource);
  assert.match(pkg.scripts["demo:bench"], /^npm run build/);
  assert.match(html, new RegExp(`orihon@${pkg.version.replaceAll(".", "\\.")}/dist/orihon\\.(?:css|esm\\.js)`));
  assert.doesNotMatch([html, embedSource, showcase, planetary, aircraft].join("\n"), /orihon@1\.0\.4/);
  assert.match(html, /ol@v10\.10\.0/);
  assert.match(html, /maplibre-gl@6\.4\.1\/dist\/maplibre-gl\.mjs/);
  assert.match(html, /maplibre-gl@6\.4\.1\/dist\/maplibre-gl\.css/);
  assert.doesNotMatch(html, /maplibre-gl@5\.24\.0|dist\/maplibre-gl\.js/);
  assert.match(html, /stats\.clusterStrategy/);
  assert.match(html, /retainFeatures:\s*false/);
  assert.match(html, /addDataAsync/);
  assert.match(html, /setDataAsync/);
  assert.match(html, /manager\.addAsync/);
  assert.match(html, /renderer:\s*"svg"/);
  assert.match(html, /htmlButtonLimit:\s*MARKER_DOM_CAP/);
  assert.match(html, /import\("\/dist\/orihon\.esm\.js" \+ localBuild\)/);
  assert.match(html, /"\?bench=" \+ Date\.now\(\)\.toString\(36\)/);
  assert.match(html, /retainedHeap/);
  assert.match(html, /NATIVE_GEOJSON_LINE_MAX\s*=\s*50_000/);
  assert.match(html, /waitForMapLibreSource\(map, "lines"/);
  assert.match(html, /createCompactLineGeoJSONUrl/);
  assert.match(html, /MultiLineString/);
  assert.match(html, /nativeGeoJSONSkipOnly/);
  assert.match(html, /value="tile-scroll"/);
  assert.match(html, /stressTileScroll/);
  assert.match(html, /visibleReady === stats\.needed/);
  assert.match(html, /stats\.preloadReady === stats\.preloadNeeded/);
  assert.match(html, /Coverage min/);
  assert.match(html, /coveragePct/);
  assert.match(html, /"tile-scroll": \["Engine"[\s\S]*"Settle", "Requests", "Reloads"/);
  assert.doesNotMatch(html, /runner\(clonePoints\(points\)\)/);
});
