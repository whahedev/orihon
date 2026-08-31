import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ObjectManager,
  Orihon,
  Point,
  GeoJSONLayer,
  VectorTileLayer,
  createWMTSFromCapabilities,
  decodeMVT,
  latLng,
  wmtsTileLayer
} from "../dist/full-entry.js";
import { TextLayer } from "../dist/standard.js";
import { pickLabelAnchor } from "../dist/services/label-layout.js";
import {
  PMTilesArchive,
  deserializePMTilesDirectory,
  findPMTilesEntry,
  zxyToTileId
} from "../dist/layers/pmtiles.js";

test("map.query walks panes and layers from topmost to bottom", () => {
  const overlay = {};
  const markerPane = {};
  const makeLayer = (name, pane) => ({
    name,
    options: { pane: name === "marker" ? "marker" : "overlay" },
    getPane: () => pane,
    queryHit() { return { layer: this, latlng: latLng({ lat: 1, lng: 2 }), source: "dom", id: name }; }
  });
  const bottom = makeLayer("bottom", overlay);
  const topInOverlay = makeLayer("top-overlay", overlay);
  const marker = makeLayer("marker", markerPane);
  const map = { layers: new Set([bottom, marker, topInOverlay]), viewport: { children: [overlay, markerPane] } };
  const hits = Orihon.prototype.query.call(map, [10, 20], { limit: Infinity });
  assert.deepEqual(hits.map((hit) => hit.id), ["marker", "top-overlay", "bottom"]);
  assert.equal(Orihon.prototype.query.call(map, [10, 20])[0].id, "marker");
  assert.equal(Orihon.prototype.query.call(map, [10, 20], { pane: "overlay" })[0].id, "top-overlay");
});

test("shared label anchor selects forty-percent along a line", () => {
  const anchor = pickLabelAnchor([{ x: 0, y: 10 }, { x: 100, y: 10 }], 100, 120, 40, 0);
  assert.deepEqual(anchor, { x: 40, y: 10 });
});

test("textLayer exposes collision defaults without adding DOM to other entries", () => {
  const layer = new TextLayer([
    { type: "Feature", properties: { name: "A" }, geometry: { type: "Point", coordinates: [37.6, 55.7] } }
  ], { text: (feature) => String(feature.properties.name) });
  assert.equal(layer.options.collision, true);
  assert.equal(layer.options.maxLabels, 500);
  assert.equal(layer.options.placement, "point");
});

test("vector tile paint rules are retained and style remains an override", () => {
  const paint = [{ layer: "water", type: "fill", fill: "#a0c8f0" }];
  const styled = () => ({ fill: "red" });
  const layer = new VectorTileLayer({ provider: async () => [], paint, style: styled });
  assert.equal(layer.options.paint, paint);
  assert.equal(layer.options.style, styled);
});

test("canvas GeoJSON hit testing keeps the source feature", () => {
  const feature = {
    type: "Feature",
    properties: { name: "area" },
    geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] }
  };
  const geo = new GeoJSONLayer(feature, { renderer: "canvas" });
  const batch = geo.getLayers()[0];
  batch.map = {
    crs: { code: "Simple" },
    latLngToContainerPoint: (value) => new Point(value[1] ?? value.lng, value[0] ?? value.lat),
    containerPointToLatLng: (value) => latLng({ lat: value.y, lng: value.x })
  };
  const hit = batch.queryHit(new Point(5, 5), { tolerance: 0, layers: [batch], pane: "", limit: 1 });
  assert.equal(batch.options.interactive, true);
  assert.equal(hit.feature, feature);
});

test("WMTS REST templates and capabilities use standard tile tokens", () => {
  const layer = wmtsTileLayer(
    "https://tiles.test/{Layer}/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png",
    { layer: "orto", style: "default", tileMatrixSet: "EPSG:3857" }
  );
  assert.equal(layer.getTileUrl(3, 4, 5), "https://tiles.test/orto/default/EPSG%3A3857/5/4/3.png");
  const config = createWMTSFromCapabilities(`
    <Capabilities><Contents><Layer><ows:Identifier>orto</ows:Identifier>
      <Style><ows:Identifier>default</ows:Identifier></Style>
      <TileMatrixSetLink><TileMatrixSet>EPSG:3857</TileMatrixSet></TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile"
        template="https://tiles.test/{TileMatrix}/{TileRow}/{TileCol}.png" />
    </Layer></Contents></Capabilities>`);
  assert.equal(config.options.layer, "orto");
  assert.equal(config.options.tileMatrixSet, "EPSG:3857");
  assert.match(config.template, /\{TileMatrix\}/);
});

test("PMTiles v3 tile ids follow the cumulative Hilbert sequence", () => {
  assert.deepEqual([
    zxyToTileId(0, 0, 0),
    zxyToTileId(1, 0, 0),
    zxyToTileId(1, 0, 1),
    zxyToTileId(1, 1, 1),
    zxyToTileId(1, 1, 0),
    zxyToTileId(12, 3423, 1763)
  ], [0, 1, 2, 3, 4, 19078479]);
});

test("PMTiles directories decode delta ids, contiguous offsets and leaf entries", () => {
  const encoded = [];
  const varint = (value) => {
    while (value >= 128) { encoded.push((value % 128) | 128); value = Math.floor(value / 128); }
    encoded.push(value);
  };
  varint(2);
  varint(5); varint(37);
  varint(1); varint(0);
  varint(42); varint(10);
  varint(1338); varint(0);
  const entries = deserializePMTilesDirectory(Uint8Array.from(encoded));
  assert.deepEqual(entries, [
    { tileId: 5, offset: 1337, length: 42, runLength: 1 },
    { tileId: 42, offset: 1379, length: 10, runLength: 0 }
  ]);
  assert.equal(findPMTilesEntry(entries, 5), entries[0]);
  assert.equal(findPMTilesEntry(entries, 42), entries[1]);
  assert.equal(findPMTilesEntry(entries, 41), null);
});

test("PMTiles archive reads v3 header, directory and tile through byte ranges", async () => {
  const archiveBytes = new Uint8Array(await readFile(new URL("./fixtures/tiny.pmtiles", import.meta.url)));
  assert.equal(new TextDecoder().decode(archiveBytes.subarray(0, 7)), "PMTiles");

  const originalFetch = globalThis.fetch;
  const ranges = [];
  globalThis.fetch = async (_url, init) => {
    const value = init.headers.Range;
    ranges.push(value);
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(value);
    return new Response(archiveBytes.slice(Number(start), Number(end) + 1), { status: 206 });
  };
  try {
    const archive = new PMTilesArchive("https://tiles.test/tiny.pmtiles");
    const tile = await archive.getTile(0, 0, 0);
    const features = decodeMVT(tile, { z: 0, x: 0, y: 0 }, { layer: "places" });
    assert.equal(features.length, 1);
    assert.equal(features[0].properties.name, "Fixture");
    assert.deepEqual(ranges, ["bytes=0-126", "bytes=127-131", `bytes=132-${archiveBytes.length - 1}`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ObjectManager enables max-zoom spiderfy by default", () => {
  const manager = new ObjectManager({ clusterize: true });
  assert.equal(manager.options.spiderfyOnMaxZoom, true);
  assert.equal(manager.options.zoomToBoundsOnClick, true);
  assert.equal(manager.options.spiderfyDistanceMultiplier, 1);
  assert.equal(typeof manager.spiderfyCluster, "function");
  assert.equal(typeof manager.unspiderfy, "function");
});
