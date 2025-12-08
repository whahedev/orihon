import test from "node:test";
import assert from "node:assert/strict";
import * as Orihon from "../dist/index.js";
import * as Standard from "../dist/standard.js";
import * as PMTiles from "orihon/pmtiles";
import * as MLT from "orihon/mlt";
import * as MvtWasm from "orihon/mvt-wasm";
import * as WebGPU from "orihon/webgpu";
import * as Controls from "orihon/controls";
import * as Geo from "orihon/geo";
import * as PopupContent from "orihon/popup-content";

test("public API exports stage one additions", () => {
  assert.equal(typeof Orihon.AttributionControl, "function");
  assert.equal(typeof Orihon.attributionControl, "function");
  assert.equal(typeof Orihon.metersToPixels, "function");
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
  assert.equal(typeof Orihon.extendBounds, "function");
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
  assert.equal(typeof WebGPU.webgpuTileLayer, "function");
  assert.equal(typeof Orihon.WTinyLfu, "function");
});

test("public API exports ObjectManager state and style types", () => {
  assert.equal(typeof Orihon.ObjectManager, "function");
  assert.equal(typeof Orihon.objectManager, "function");
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
  assert.equal(typeof Orihon.webglStyledPathBatch, "function");
  assert.equal(typeof Orihon.webglPolygonBatch, "function");
  assert.equal(typeof Orihon.heatKernelAtZoom, "function");
  assert.equal(typeof Orihon.heatIntensityScale, "function");
  manager.destroy();
});
