import test from "node:test";
import assert from "node:assert/strict";
import {
  CircleMarker,
  FeatureGroup,
  GeoJSONLayer,
  Marker,
  Polygon,
  WMSTileLayer,
  circleMarker,
  geoJSON,
  polygon,
  wmsTileLayer
} from "../dist/index.js";
import { registerGeoJSONWebGLBatch } from "../dist/layers/geojson.js";
import { WebGLPathBatch, webglPathBatch } from "../dist/layers/webgl-path-batch.js";

test("GeoJSON auto renderer batches large path sets on one WebGL layer (Advanced)", () => {
  const features = Array.from({ length: 300 }, (_, index) => ({
    type: "Feature",
    id: index,
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: [
        [13 + index * 0.001, 52],
        [13.1 + index * 0.001, 52.1]
      ]
    }
  }));
  const layer = geoJSON(
    { type: "FeatureCollection", features },
    { renderer: "auto", style: { stroke: "#0f766e", strokeWidth: 1.5 } }
  );
  assert.equal(layer.rendererMode, "webgl");
  assert.equal(layer.featureEntries.length, 300);
  assert.equal(layer.getLayers().length, 1);
  assert.equal(layer.toGeoJSON().features.length, 300);
});

test("GeoJSON auto falls back to canvas when WebGL backend is unregistered", () => {
  const features = Array.from({ length: 300 }, (_, index) => ({
    type: "Feature",
    id: index,
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: [
        [13 + index * 0.001, 52],
        [13.1 + index * 0.001, 52.1]
      ]
    }
  }));
  registerGeoJSONWebGLBatch(null);
  try {
    const layer = geoJSON(
      { type: "FeatureCollection", features },
      { renderer: "auto", style: { stroke: "#0f766e", strokeWidth: 1.5 } }
    );
    assert.equal(layer.rendererMode, "canvas");
  } finally {
    registerGeoJSONWebGLBatch((options) => new WebGLPathBatch(options));
  }
});

test("GeoJSON canvas renderer still batches when requested", () => {
  const features = Array.from({ length: 12 }, (_, index) => ({
    type: "Feature",
    id: index,
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: [
        [13 + index * 0.001, 52],
        [13.1 + index * 0.001, 52.1]
      ]
    }
  }));
  const layer = geoJSON(
    { type: "FeatureCollection", features },
    { renderer: "canvas", style: { stroke: "#0f766e", strokeWidth: 1.5 } }
  );
  assert.equal(layer.rendererMode, "canvas");
  assert.equal(layer.getLayers().length, 1);
});

test("WebGLPathBatch keeps vertex buffer large enough for many segments", () => {
  const batch = webglPathBatch({ stroke: "#0f766e", strokeWidth: 2 });
  for (let i = 0; i < 200; i++) {
    batch.addPath(
      [
        [
          [52 + i * 0.01, 13],
          [52.1 + i * 0.01, 13.2],
          [52.05 + i * 0.01, 13.4],
          [52.15 + i * 0.01, 13.6]
        ]
      ],
      false
    );
  }
  // 200 lines × 3 segments × 6 verts
  assert.equal(batch.count, 200 * 3);
  assert.ok(batch.getBounds().isValid());
});

test("GeoJSON creates point, multi-point and path feature layers", () => {
  const visited = [];
  const layer = geoJSON({
    type: "FeatureCollection",
    features: [
      { type: "Feature", id: "point", properties: { kind: "point" }, geometry: { type: "Point", coordinates: [13.405, 52.52] } },
      { type: "Feature", id: "multi", properties: { kind: "point" }, geometry: { type: "MultiPoint", coordinates: [[13.35, 52.48], [13.50, 52.56]] } },
      { type: "Feature", id: "line", properties: { kind: "line" }, geometry: { type: "LineString", coordinates: [[13.30, 52.48], [13.55, 52.58]] } },
      { type: "Feature", id: "skip", properties: { hidden: true }, geometry: { type: "Point", coordinates: [0, 0] } }
    ]
  }, {
    filter: (feature) => feature.properties?.hidden !== true,
    pointToLayer: (_feature, position) => circleMarker(position, { radius: 7 }),
    style: (feature) => ({ stroke: feature.properties?.kind === "line" ? "#f00" : "#00f" }),
    onEachFeature: (feature) => visited.push(feature.id)
  });

  assert.ok(layer instanceof GeoJSONLayer);
  assert.deepEqual(visited, ["point", "multi", "line"]);
  assert.equal(layer.getLayers().length, 3);
  assert.ok(layer.getLayers()[0] instanceof CircleMarker);
  assert.ok(layer.getLayers()[1] instanceof FeatureGroup);
  assert.equal(layer.getBounds().contains([52.52, 13.405]), true);
  assert.equal(layer.toGeoJSON().features.length, 3);
});

test("GeoJSON propagates feature events and updates point round-trips", () => {
  const layer = geoJSON({
    type: "Feature",
    id: "editable",
    properties: { title: "Point" },
    geometry: { type: "Point", coordinates: [30, 60] }
  });
  const point = layer.getLayers()[0];
  let clicked = false;
  layer.on("click", (event) => { clicked = event.sourceTarget === point; });
  point.emit("click");
  assert.equal(clicked, true);
  assert.ok(point instanceof Marker);
  point.setLatLng([61, 31]);
  assert.deepEqual(layer.toGeoJSON(4).features[0].geometry.coordinates, [31, 61]);

  layer.addData({
    type: "GeometryCollection",
    geometries: [
      { type: "Point", coordinates: [32, 62] },
      { type: "Polygon", coordinates: [[[30, 60], [31, 60], [31, 61], [30, 60]]] }
    ]
  });
  assert.equal(layer.getLayers().length, 2);
  layer.clearLayers();
  assert.equal(layer.toGeoJSON().features.length, 0);
});

test("Polygon supports nested rings for holes", () => {
  const area = polygon([
    [[0, 0], [0, 4], [4, 4], [4, 0]],
    [[1, 1], [2, 1], [2, 2], [1, 1]]
  ]);

  assert.ok(area instanceof Polygon);
  assert.equal(area.getLatLngs().length, 2);
  assert.equal(area.getBounds().toBBoxString(), "0,0,4,4");
});

test("WMSTileLayer builds projected and axis-ordered requests", () => {
  const projected = wmsTileLayer("https://maps.example/wms?token=x", {
    layers: "workspace:roads",
    transparent: true,
    format: "image/png"
  });
  const projectedUrl = new URL(projected.getTileUrl(0, 0, 0));
  assert.ok(projected instanceof WMSTileLayer);
  assert.equal(projectedUrl.searchParams.get("service"), "WMS");
  assert.equal(projectedUrl.searchParams.get("layers"), "workspace:roads");
  assert.equal(projectedUrl.searchParams.get("crs"), "EPSG:3857");
  assert.equal(projectedUrl.searchParams.get("bbox"), "-20037508.342789244,-20037508.342789244,20037508.342789244,20037508.342789244");

  const geographic = wmsTileLayer("https://maps.example/wms", {
    layers: "weather",
    crs: "EPSG:4326",
    version: "1.3.0",
    uppercase: true
  });
  const geographicUrl = new URL(geographic.getTileUrl(0, 0, 1));
  assert.equal(geographicUrl.searchParams.get("CRS"), "EPSG:4326");
  assert.equal(geographicUrl.searchParams.get("BBOX"), "0,-180,85.0511287798066,0");
  geographic.setParams({ layers: "temperature" }, true);
  assert.equal(geographic.getParams().layers, "temperature");
});

