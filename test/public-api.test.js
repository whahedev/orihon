import test from "node:test";
import assert from "node:assert/strict";
import * as Orihon from "../dist/index.js";
import * as Core from "../dist/core.js";
import * as Standard from "../dist/standard.js";
import * as PMTiles from "orihon/pmtiles";
import * as MLT from "orihon/mlt";
import * as MvtWasm from "orihon/mvt-wasm";
import * as MVT from "orihon/mvt";
import * as WebGPU from "orihon/webgpu";
import * as Controls from "orihon/controls";
import * as Geo from "orihon/geo";
import * as PopupContent from "orihon/popup-content";
import * as Source from "orihon/source";

test("public API exports stage one additions", () => {
  assert.equal(typeof Orihon.AttributionControl, "function");
  assert.equal(typeof Orihon.attributionControl, "function");
  assert.equal(typeof Orihon.metersToPixels, "function");
});

test("geometry worker ownership is explicit in the public API", () => {
  assert.equal(typeof Orihon.createGeometryWorkerPool, "function");
  assert.equal("getSharedGeometryWorkerPool" in Orihon, false);
});

test("feature source is isolated in its optional entry", () => {
  assert.equal(typeof Source.FeatureSource, "function");
  assert.equal(typeof Source.featureSource, "function");
  assert.equal(Source.createFeatureSource, Source.featureSource);
  assert.equal("featureSource" in Standard, false);
  assert.equal("featureSource" in Orihon, false);
});

test("public API does not expose renderer wiring helpers", () => {
  for (const name of [
    "registerGpuTileFactory",
    "geoTransformCss",
    "cameraWarpCss",
    "cameraWarpCoversViewport",
    "tileCornerLayerTransform",
    "tileLevelWarpCss"
  ]) {
    assert.equal(name in Orihon, false, `${name} leaked into the public package entry`);
  }
});

test("packed MVT decoding is isolated in the advanced subpath", () => {
  assert.equal("decodePackedMVT" in Orihon, false);
  assert.equal("packedToGeoJSON" in Orihon, false);
  assert.equal(typeof MVT.decodePackedMVT, "function");
  assert.equal(typeof MVT.decodePackedMVTAsync, "function");
  assert.equal(typeof MVT.packedToGeoJSON, "function");
});

test("public API exports P2 optional controls and geo helpers", () => {
  assert.equal(typeof Orihon.Orihon.prototype.exportPng, "function");
  assert.equal(typeof Orihon.Orihon.prototype.print, "function");
  assert.equal(typeof Controls.fullscreenControl, "function");
  assert.equal(typeof Controls.measureControl, "function");
  assert.equal(typeof Controls.miniMap, "function");
  assert.equal(typeof Controls.graticuleLayer, "function");
  assert.equal(typeof Geo.bufferPoint, "function");
});

test("popup content entry exposes the declarative renderer without a chart dependency", () => {
  assert.equal(typeof PopupContent.popupContent, "function");
  assert.equal(typeof PopupContent.sanitizePopupHtml, "function");
  assert.equal(typeof PopupContent.popupConditionMatches, "function");
  assert.equal(typeof PopupContent.createEChartsPopupRenderer, "function");
});

test("public API exports the complete geometry toolkit", () => {
  assert.equal(typeof Orihon.bounds, "function");
  assert.equal(typeof Orihon.lngLat, "function");
  assert.equal(typeof Core.lngLat, "function");
  assert.equal(typeof Standard.lngLat, "function");
  assert.equal(typeof Geo.lngLat, "function");
  assert.deepEqual(Orihon.lngLat(13.405, 52.52).toArray(), [52.52, 13.405]);
  assert.equal("latLngBounds" in Orihon, false);
  assert.equal("latLngBounds" in Standard, false);
  assert.equal("latLngBounds" in Geo, false);
  const area = Orihon.bounds([[52, 13], [53, 14], [51, 15]]);
  assert.equal(area.toBBoxString(), "13,51,15,53");
  assert.equal(Orihon.bounds(area), area);
  assert.equal(Orihon.bounds(area, { south: 50, west: 12, north: 54, east: 16 }).toBBoxString(), "12,50,16,54");
  assert.equal("extendBounds" in Orihon, false);
  assert.equal(typeof Orihon.scale, "function");
  assert.equal(typeof Orihon.zoomForBounds, "function");
  assert.equal(Orihon.TILE_SIZE, 256);
  assert.ok(Orihon.MAX_LAT > 85);
  assert.ok(Orihon.EARTH_RADIUS > 6_000_000);
  assert.equal(typeof Orihon.CRS.Simple.project, "function");
  assert.equal(typeof Orihon.destination, "function");
  assert.equal(typeof Orihon.geodesicInterpolate, "function");
});

test("public API exports P1 query, labels, WMTS, MVT paint and PMTiles entries", () => {
  assert.equal(typeof Orihon.Orihon.prototype.query, "function");
  assert.equal(typeof Orihon.Orihon.prototype.queryLatLng, "function");
  assert.equal(typeof Orihon.TextLayer, "function");
  assert.equal(typeof Orihon.textLayer, "function");
  assert.equal(typeof Orihon.WMTSTileLayer, "function");
  assert.equal(typeof Orihon.wmtsTileLayer, "function");
  assert.equal(typeof Standard.textLayer, "function");
  assert.equal(typeof Standard.wmtsTileLayer, "function");
  assert.equal(typeof PMTiles.PMTilesArchive, "function");
  assert.equal(typeof PMTiles.createPMTilesProvider, "function");
  assert.equal(typeof PMTiles.createPMTilesRasterSource, "function");
  assert.equal(typeof MLT.decodePackedMLT, "function");
  assert.equal(typeof MLT.encodePackedMLT, "function");
  assert.equal(typeof MvtWasm.decodePackedMVTWasm, "function");
  assert.equal("gpuTileLayer" in WebGPU, false);
  assert.equal("gpuTileLayer" in Orihon, false);
  assert.equal(typeof Orihon.WTinyLfu, "function");
});

test("public API exports ObjectManager state and style types", () => {
  assert.equal(typeof Orihon.ObjectManager, "function");
  assert.equal(typeof Orihon.objectManager, "function");
  assert.equal(typeof Orihon.searchProvider, "function");
  assert.equal(typeof Orihon.pathBatch, "function");
  for (const removed of [
    "remoteObjectManager", "markerCollection", "createSearchProvider", "createArraySearchProvider",
    "webglPathBatch", "webglStyledPathBatch", "divIcon", "gridLayer", "canvasBaseLayer", "extendBounds"
  ]) assert.equal(removed in Orihon, false, `${removed} must not remain in the main API`);
  assert.equal("gridLayer" in Core, false);
  assert.equal("gridLayer" in Standard, false);
  assert.equal("canvasBaseLayer" in Standard, false);
  assert.ok(Orihon.icon({ content: "A" }) instanceof Orihon.DivIcon);
  assert.ok(Orihon.icon({ iconUrl: "marker.png" }) instanceof Orihon.Icon);
  assert.ok(Orihon.objectManager({ points: [[1, 2]], renderer: "svg" }) instanceof Orihon.MarkerCollection);
  assert.ok(Orihon.objectManager({ loader: async () => [] }) instanceof Orihon.RemoteObjectManager);
  assert.ok(Orihon.searchProvider([{ name: "A", center: [1, 2] }]) instanceof Orihon.SearchProvider);
  assert.ok(Orihon.OBJECT_MANAGER_PALETTE);
  const manager = Orihon.objectManager();
  assert.equal(typeof manager.setObjectState, "function");
  assert.equal(typeof manager.setObjectStates, "function");
  assert.equal(typeof manager.getObjectState, "function");
  assert.equal(typeof manager.removeObjectState, "function");
  assert.equal(typeof manager.clearObjectStates, "function");
  assert.equal(typeof manager.setStyle, "function");
  assert.equal(typeof manager.registerIcon, "function");
  assert.equal(typeof manager.search, "function");
  assert.equal(typeof manager.setTimeRange, "function");
  assert.equal(typeof manager.setVisualization, "function");
  assert.equal(typeof manager.updateObjects, "function");
  assert.equal(typeof Orihon.WebGLSymbolLayer, "function");
  assert.ok(Orihon.pathBatch({ mode: "uniform" }) instanceof Orihon.WebGLPathBatch);
  assert.ok(Orihon.pathBatch({ mode: "feature" }) instanceof Orihon.WebGLStyledPathBatch);
  assert.equal(typeof Orihon.webglPolygonBatch, "function");
  assert.equal(typeof Orihon.HeatLayer, "function");
  assert.equal(typeof Orihon.heatLayer, "function");
  assert.equal(typeof Orihon.buildHeat, "function");
  assert.equal(typeof Orihon.heatSupport, "function");
  assert.equal("webglHeatLayer" in Orihon, false);
  assert.equal("heatIsolineLayer" in Orihon, false);
  assert.equal("buildHeatPipeline" in Orihon, false);
  manager.destroy();
});
