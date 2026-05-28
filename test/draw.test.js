import test from "node:test";
import assert from "node:assert/strict";
import { DrawHandler } from "../dist/draw/handler.js";
import { createDrawModeIcon } from "../dist/draw/control.js";
import { drawHandle } from "../dist/draw/handles.js";
import { latLng } from "../dist/geo.js";
import { rectangle } from "../dist/layers/vector.js";
import { JSDOM } from "jsdom";

test("draw mode icons are visible SVGs and remain presentation-only", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  globalThis.document = dom.window.document;
  try {
    for (const mode of ["point", "polyline", "polygon", "rectangle", "circle", "edit", "delete"]) {
      const icon = createDrawModeIcon(mode);
      assert.equal(icon.tagName.toLowerCase(), "svg");
      assert.equal(icon.getAttribute("aria-hidden"), "true");
      assert.ok(icon.childElementCount > 0, `${mode} icon must contain visible geometry`);
    }
  } finally {
    delete globalThis.document;
  }
});

test("rectangle accepts LatLng drag endpoints and produces editable vertices", () => {
  const shape = rectangle([latLng({ lat: 55.7, lng: 37.5 }), latLng({ lat: 55.8, lng: 37.7 })]);
  assert.equal(shape.getBounds().isValid(), true);
  assert.deepEqual(shape.getLatLngs()[0].map(({ lat, lng }) => [lat, lng]), [
    [55.8, 37.5],
    [55.8, 37.7],
    [55.7, 37.7],
    [55.7, 37.5]
  ]);
});

test("edit handles suppress the default map-pin content", () => {
  const handle = drawHandle({ lat: 55.75, lng: 37.62 }, "vertex", 0, 0);
  assert.equal(handle.marker.options.content, "");
  assert.match(handle.marker.options.className, /oh-draw-vertex-handle/);
});

test("draw GeoJSON round-trips points, lines, polygons and circles", () => {
  const draw = new DrawHandler();
  draw.loadData({
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [10, 20] } },
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } },
      { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] } },
      { type: "Feature", properties: { radiusMeters: 500 }, geometry: { type: "Point", coordinates: [3, 4] } }
    ]
  });
  const output = draw.toGeoJSON();
  assert.deepEqual(output.features.map((feature) => feature.geometry.type), ["Point", "LineString", "Polygon", "Point"]);
  assert.equal(output.features[3].properties.radiusMeters, 500);
  assert.deepEqual(output.features[2].geometry.coordinates[0][0], output.features[2].geometry.coordinates[0].at(-1));
});

test("draw history undoes and redoes loaded snapshots", () => {
  const draw = new DrawHandler();
  draw.loadData({ type: "Point", coordinates: [1, 2] });
  assert.equal(draw.toGeoJSON().features.length, 1);
  draw.undo();
  assert.equal(draw.toGeoJSON().features.length, 0);
  draw.redo();
  assert.equal(draw.toGeoJSON().features.length, 1);
});

test("recordEdit puts an outside edit on the undo stack", () => {
  const draw = new DrawHandler();
  draw.loadData({ type: "LineString", coordinates: [[1, 2], [3, 4]] });
  const [line] = draw.featureGroup.getLayers();
  const edited = [];
  draw.on("editcomplete", (event) => edited.push(event.layer));

  // A host application with its own handles mutates the layer directly; nothing in the plugin
  // observes that, so without recordEdit the change never reaches the history.
  line.setLatLngs([{ lat: 20, lng: 10 }, { lat: 4, lng: 3 }]);
  draw.recordEdit(line);
  assert.deepEqual(edited, [line]);
  assert.deepEqual(draw.toGeoJSON().features[0].geometry.coordinates[0], [10, 20]);

  draw.undo();
  assert.deepEqual(draw.toGeoJSON().features[0].geometry.coordinates[0], [1, 2]);
  draw.redo();
  assert.deepEqual(draw.toGeoJSON().features[0].geometry.coordinates[0], [10, 20]);
});

test("draw locales include redo labels", async () => {
  const { resolveDrawLocale } = await import("../dist/draw/locale.js");
  assert.equal(resolveDrawLocale("en").drawRedo, "Redo");
  assert.ok(resolveDrawLocale("ru").drawRedo.includes("Повтор"));
});

test("setMode rejects disabled modes and emits modechange", () => {
  const draw = new DrawHandler({ modes: ["point", "edit"] });
  const modes = [];
  draw.on("modechange", (event) => modes.push(event.mode));
  draw.setMode("point");
  assert.equal(draw.mode, "point");
  assert.throws(() => draw.setMode("polygon"), /not enabled/);
  draw.setMode("off");
  assert.deepEqual(modes, ["point", "off"]);
});

test("circle GeoJSON edit surface stays a radius point feature", () => {
  const draw = new DrawHandler();
  draw.loadData({
    type: "Feature",
    properties: { radiusMeters: 250 },
    geometry: { type: "Point", coordinates: [37.6, 55.7] }
  });
  const [feature] = draw.toGeoJSON().features;
  assert.equal(feature.geometry.type, "Point");
  assert.equal(feature.properties.radiusMeters, 250);
  const layer = draw.featureGroup.getLayers()[0];
  assert.equal(layer.constructor.name, "Circle");
  assert.deepEqual(layer.getRadius(), { radiusMeters: 250 });
});
