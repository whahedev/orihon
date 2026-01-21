import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("developer guide has one physical page per catalogued public function", async () => {
  const manifest = JSON.parse(await readFile(new URL("examples/developer-guide/manifest.json", root), "utf8"));
  assert.ok(manifest.functions.length >= 70, `unexpectedly small guide: ${manifest.functions.length}`);
  assert.equal(new Set(manifest.functions.map((item) => item.name)).size, manifest.functions.length);
  for (const internalName of [
    "latLngBounds",
    "gpuTileLayer",
    "remoteObjectManager",
    "markerCollection",
    "createSearchProvider",
    "createArraySearchProvider",
    "webglPathBatch",
    "webglStyledPathBatch",
    "divIcon",
    "extendBounds",
    "gridLayer",
    "canvasBaseLayer",
    "registerGpuTileFactory",
    "geoTransformCss",
    "cameraWarpCss",
    "cameraWarpCoversViewport",
    "tileCornerLayerTransform",
    "tileLevelWarpCss"
  ]) {
    assert.equal(manifest.functions.some((item) => item.name === internalName), false, `${internalName} is internal`);
  }
  for (const publicName of [
    "tileLayer", "objectManager", "searchProvider", "pathBatch", "icon", "bounds",
    "buildClusterIndex", "buildClusterLayout", "queryClusterLayout"
  ]) {
    assert.equal(manifest.functions.some((item) => item.name === publicName), true, `${publicName} must be documented`);
  }

  await Promise.all(manifest.functions.map(async (item) => {
    const page = new URL(`examples/developer-guide/functions/${item.name}/index.html`, root);
    await access(page);
    const html = await readFile(page, "utf8");
    assert.match(html, /<h2>Для чего нужна<\/h2>/, `${item.name} has no purpose section`);
    assert.match(html, /data-playground[\s\S]*data-playground-code[\s\S]*data-playground-frame/, `${item.name} has no live playground`);
    assert.match(html, /sandbox="allow-scripts"/, `${item.name} playground is not isolated`);
  }));
});

test("developer guide source contains only current public APIs", async () => {
  const [sourceText, manifestText] = await Promise.all([
    readFile(new URL("docs/developer-guide/confluence-source.json", root), "utf8"),
    readFile(new URL("examples/developer-guide/manifest.json", root), "utf8")
  ]);
  const source = JSON.parse(sourceText);
  const manifest = JSON.parse(manifestText);
  const currentNames = new Set(manifest.functions.map((item) => item.name));
  for (const supplementalName of ["locales"]) {
    currentNames.add(supplementalName);
  }

  for (const page of source.pages) {
    const name = page.title.replace(/^Orihon API - /, "");
    assert.equal(currentNames.has(name), true, `${name} is stale or missing from the public API catalog`);
  }

  for (const removedName of [
    "canvasBaseLayer",
    "extendBounds",
    "gridLayer",
    "heatIsolineLayer",
    "latLngBounds",
    "webglHeatLayer",
    "webglTileLayer"
  ]) {
    assert.doesNotMatch(sourceText, new RegExp(`\\b${removedName}\\b`), `${removedName} remains in guide source`);
  }
  assert.doesNotMatch(sourceText, /through `geometryWorkerPool`|через `geometryWorkerPool`/);
});

test("developer guide exposes only the unified current heat API", async () => {
  const [manifestSource, home, layer, build, support] = await Promise.all([
    readFile(new URL("examples/developer-guide/manifest.json", root), "utf8"),
    readFile(new URL("examples/developer-guide/index.html", root), "utf8"),
    readFile(new URL("examples/developer-guide/functions/heatLayer/index.html", root), "utf8"),
    readFile(new URL("examples/developer-guide/functions/buildHeat/index.html", root), "utf8"),
    readFile(new URL("examples/developer-guide/functions/heatSupport/index.html", root), "utf8")
  ]);
  const manifest = JSON.parse(manifestSource);
  const heatNames = manifest.functions.filter((item) => item.group === "Тепловые карты и изолинии").map((item) => item.name);
  assert.deepEqual(heatNames, ["heatLayer", "heatSupport"]);
  assert.match(home, /Heat API обновлён/);
  assert.match(layer, /mode:[\s\S]*backend:[\s\S]*evaluation:[\s\S]*worker:/);
  assert.match(layer, /Состав <code>options<\/code>[\s\S]*<code>backend<\/code>[\s\S]*<code>evaluation<\/code>/);
  assert.match(layer, /WASM\/WebGPU|WebGPU[\s\S]*WASM/);
  assert.match(layer, /getFeatureAt\(\)[\s\S]*selectFeature\(\)/);
  assert.match(build, /fieldMs[\s\S]*contoursMs[\s\S]*readbackMs[\s\S]*totalMs/);
  assert.match(support, /support\.wasm[\s\S]*support\.webgpu/);
  assert.doesNotMatch(manifestSource, /webglHeatLayer|heatIsolineLayer|buildHeatIsolines/);
});

test("developer guide separates render-free computation functions", async () => {
  const [manifestSource, home] = await Promise.all([
    readFile(new URL("examples/developer-guide/manifest.json", root), "utf8"),
    readFile(new URL("examples/developer-guide/index.html", root), "utf8")
  ]);
  const manifest = JSON.parse(manifestSource);
  const calculations = manifest.functions
    .filter((item) => item.group === "Вычисления без отрисовки")
    .map((item) => item.name);
  for (const expected of [
    "bounds", "distance", "project", "zoomForBounds", "buildHeat",
    "buildClusterIndex", "buildClusterLayout", "queryClusterLayout",
    "decodeMVT",
    "preparePointBatch", "preparePointBatchAsync", "createWMTSFromCapabilities"
  ]) {
    assert.ok(calculations.includes(expected), `${expected} must be catalogued as a render-free computation`);
  }
  assert.equal(calculations.includes("heatLayer"), false);
  assert.equal(calculations.includes("tileLayer"), false);
  assert.equal(manifest.functions.some((item) => item.name === "decodePackedMVT"), false);
  assert.equal(manifest.functions.some((item) => item.name === "packedToGeoJSON"), false);
  assert.match(home, /Вычисления без отрисовки/);
  assert.match(home, /Эти функции сами ничего не добавляют на карту/);
});

test("developer guide separates package tiers from API complexity", async () => {
  const home = await readFile(new URL("examples/developer-guide/index.html", root), "utf8");
  assert.match(home, /Package tier ≠ сложность API/);
  assert.match(home, /Easy, Layer API и Rendering API/);
  assert.match(home, /orihon\/easy/);
});

test("developer guide playground executes the local build in an isolated map", async () => {
  const [playground, script] = await Promise.all([
    readFile(new URL("examples/developer-guide/playground.html", root), "utf8"),
    readFile(new URL("examples/developer-guide/assets/guide.js", root), "utf8")
  ]);
  assert.match(playground, /import\("\/dist\/orihon\.esm\.js\?developer-guide=1"\)/);
  assert.match(playground, /orihon-playground-ready[\s\S]*orihon-playground-run/);
  assert.doesNotMatch(playground, /id="output"/);
  assert.match(playground, /orihon-playground-result/);
  assert.match(playground, /resetMap\(\)/);
  assert.match(script, /Ctrl\+Enter|ctrlKey[\s\S]*Enter/);
  assert.match(script, /data-playground-run[\s\S]*data-playground-reset/);
});

test("developer guide uses concrete purpose and parameter explanations", async () => {
  const boundsPage = await readFile(new URL("examples/developer-guide/functions/bounds/index.html", root), "utf8");
  assert.match(boundsPage, /географическую область/);
  assert.match(boundsPage, /массив координат/);
  assert.match(boundsPage, /существующий LatLngBounds/);
  assert.match(boundsPage, /Необязательный второй противоположный угол/);
  assert.match(boundsPage, /Для прямоугольника в экранных или мировых пикселях используйте <code>pointBounds\(\)<\/code>/);
  assert.doesNotMatch(boundsPage, /Создает пиксельные bounds|Точный допустимый формат|типизированный результат операции/);

  const lngLatPage = await readFile(new URL("examples/developer-guide/functions/lngLat/index.html", root), "utf8");
  assert.match(lngLatPage, /function lngLat\(lng: number, lat: number\): LatLng/);
  assert.match(lngLatPage, /MapLibre и массивах координат GeoJSON/);
  assert.match(lngLatPage, /marker\(berlin\)\.addTo\(map\)/);

  const functionsRoot = new URL("examples/developer-guide/functions/", root);
  const manifest = JSON.parse(await readFile(new URL("examples/developer-guide/manifest.json", root), "utf8"));
  for (const item of manifest.functions) {
    const html = await readFile(new URL(`${item.name}/index.html`, functionsRoot), "utf8");
    assert.doesNotMatch(html, /Точный допустимый формат|типизированный результат операции|Выполняет операцию|Создаёт или вычисляет|единицы и диапазон определены|Настраивает «/);
    assert.match(html, /data-playground-output/);
  }
});

test("developer guide generator is wired to the local docs server", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(pkg.scripts["docs:build"], "node scripts/build-developer-guide.mjs");
  assert.equal(pkg.scripts["docs:check"], "node scripts/check-developer-guide.mjs");
  assert.match(pkg.scripts.check, /docs:check/);
  assert.match(pkg.scripts["demo:docs"], /docs:build[\s\S]*developer-guide-server\.mjs/);
  const checker = await readFile(new URL("scripts/check-developer-guide.mjs", root), "utf8");
  assert.match(checker, /build-developer-guide\.mjs[\s\S]*git[\s\S]*diff[\s\S]*--exit-code/);
  const server = await readFile(new URL("scripts/developer-guide-server.mjs", root), "utf8");
  assert.match(server, /ORIHON_DOCS_PORT[\s\S]*4179/);
  assert.match(server, /candidate !== root[\s\S]*startsWith\(root \+ sep\)/);
});
