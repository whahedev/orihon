import test from "node:test";
import assert from "node:assert/strict";
import {
  CircleMarker,
  DivIcon,
  GridLayer,
  Icon,
  ImageOverlay,
  LayersControl,
  Marker,
  Popup,
  Rectangle,
  SVGOverlay,
  Tooltip,
  VideoOverlay,
  circle,
  circleMarker,
  icon,
  imageOverlay,
  bounds,
  layersControl,
  marker,
  polygon,
  polyline,
  rectangle,
  svgOverlay,
  videoOverlay
} from "../dist/full-entry.js";
import { svgAttributeIsDangerous, svgTagIsDangerous } from "../dist/overlays/svg-overlay.js";

test("SVG sanitizer policy rejects scripts, style, external href and handlers", () => {
  assert.equal(svgTagIsDangerous("script"), true);
  assert.equal(svgTagIsDangerous("foreignObject"), true);
  assert.equal(svgTagIsDangerous("style"), true);
  assert.equal(svgTagIsDangerous("use"), true);
  assert.equal(svgTagIsDangerous("path"), false);
  assert.equal(svgAttributeIsDangerous("onclick", "alert(1)"), true);
  assert.equal(svgAttributeIsDangerous("style", "color:red"), true);
  assert.equal(svgAttributeIsDangerous("href", "https://evil.example/x"), true);
  assert.equal(svgAttributeIsDangerous("xlink:href", "javascript:alert(1)"), true);
  assert.equal(svgAttributeIsDangerous("href", "#icon"), false);
  assert.equal(svgAttributeIsDangerous("fill", "red"), false);
});

test("layers expose popup and tooltip binding API", () => {
  const layer = marker({ lat: 52.52, lng: 13.405 });
  layer.bindPopup("Popup").bindTooltip("Tooltip");

  assert.ok(layer.getPopup() instanceof Popup);
  assert.ok(layer.getTooltip() instanceof Tooltip);
  assert.equal(layer.isPopupOpen(), false);
  assert.equal(layer.isTooltipOpen(), false);

  layer.unbindPopup().unbindTooltip();
  assert.equal(layer.getPopup(), null);
  assert.equal(layer.getTooltip(), null);
});

test("all SVG geometry types accept popup click bindings", () => {
  const layers = [
    polyline([{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }]),
    polygon([{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }]),
    rectangle([{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }]),
    circle({ lat: 0, lng: 0 }, { radiusMeters: 100 }),
    circleMarker({ lat: 0, lng: 0 })
  ];
  for (const layer of layers) {
    layer.bindPopup("Geometry popup");
    assert.equal(layer.listens("click"), true, layer.constructor.name);
    assert.ok(layer.getPopup(), layer.constructor.name);
    layer.emit("click", { latlng: layer.getBounds?.().getCenter?.() ?? layer.getLatLng?.() });
  }
});

test("DivIcon strings stay text even when they look like HTML", () => {
  const assigned = { innerHTML: 0, textContent: "" };
  const element = {
    className: "",
    style: {},
    get textContent() { return assigned.textContent; },
    set textContent(value) { assigned.textContent = String(value); },
    get innerHTML() { return assigned.textContent; },
    set innerHTML(_value) { assigned.innerHTML += 1; },
    replaceChildren() {}
  };
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  const previousHTMLDivElement = globalThis.HTMLDivElement;
  globalThis.document = { createElement: () => element };
  globalThis.Node = class FakeNode {};
  globalThis.HTMLDivElement = class FakeHTMLDivElement {};
  try {
    const payload = "<img src=x onerror=alert(1)>";
    const created = icon({ content: payload }).createIcon();
    assert.equal(created, element);
    assert.equal(assigned.innerHTML, 0);
    assert.equal(assigned.textContent, payload);
  } finally {
    globalThis.document = previousDocument;
    globalThis.Node = previousNode;
    globalThis.HTMLDivElement = previousHTMLDivElement;
  }
});

test("Icon and DivIcon retain size, anchor and circular image semantics", () => {
  const image = icon({
    iconUrl: "marker.png",
    iconSize: [30, 40],
    iconAnchor: [15, 40],
    shape: "circle",
    fit: "cover",
    borderColor: "white",
    borderWidth: 3
  });
  const div = icon({ content: "A", iconSize: [28, 28] });

  assert.ok(image instanceof Icon);
  assert.deepEqual(image.getSize().toArray(), [30, 40]);
  assert.deepEqual(image.getAnchor().toArray(), [15, 40]);
  assert.equal(image.options.shape, "circle");
  assert.equal(image.options.fit, "cover");
  assert.equal(image.options.borderWidth, 3);
  assert.ok(div instanceof DivIcon);
  assert.deepEqual(div.getAnchor().toArray(), [14, 14]);

  const layer = new Marker({ lat: 0, lng: 0 }, { icon: div });
  assert.equal(layer.getIcon(), div);
  layer.setIcon(image);
  assert.equal(layer.getIcon(), image);
});

test("Marker draggability can be changed without recreating the layer", () => {
  const layer = marker({ lat: 1, lng: 2 });
  assert.equal(layer.isDraggable(), false);
  assert.equal(layer.setDraggable(true), layer);
  assert.equal(layer.isDraggable(), true);
  layer.setDraggable(false);
  assert.equal(layer.isDraggable(), false);
});

test("Rectangle, Circle and CircleMarker expose mutable geometry", () => {
  const box = bounds({ lat: 10, lng: 20 }, { lat: 12, lng: 24 });
  const area = rectangle(box);
  const dot = circleMarker({ lat: 11, lng: 22 }, { radiusPixels: 12 });
  const metric = circle({ lat: 11, lng: 22 }, { radiusMeters: 1000 });

  assert.ok(area instanceof Rectangle);
  assert.equal(area.getBounds().toBBoxString(), "20,10,24,12");
  area.setBounds([{ lat: 0, lng: 1 }, { lat: 2, lng: 3 }]);
  assert.equal(area.getBounds().toBBoxString(), "1,0,3,2");

  assert.ok(dot instanceof CircleMarker);
  assert.equal(dot.getRadiusPixels(), 12);
  dot.setRadiusPixels(18).setLatLng({ lat: 5, lng: 6 });
  assert.equal(dot.getRadiusPixels(), 18);
  assert.deepEqual([dot.getLatLng().lat, dot.getLatLng().lng], [5, 6]);
  assert.equal(metric.getBounds().contains(metric.getLatLng()), true);
});

test("ImageOverlay and LayersControl factories expose lifecycle state", () => {
  const overlay = imageOverlay("overlay.png", [{ lat: 55, lng: 37 }, { lat: 56, lng: 38 }], { opacity: 0.5 });
  const base = marker({ lat: 0, lng: 0 });
  const control = layersControl({ Base: base }, { Image: overlay }, { collapsed: false });

  assert.ok(overlay instanceof ImageOverlay);
  assert.equal(overlay.getBounds().toBBoxString(), "37,55,38,56");
  assert.equal(overlay.options.zIndex, 0);
  overlay.setBounds([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }]).setOpacity(0.7).setZIndex(4).setUrl("next.png");
  assert.equal(overlay.getBounds().toBBoxString(), "2,1,4,3");
  assert.equal(overlay.url, "next.png");

  assert.ok(control instanceof LayersControl);
  assert.equal(control.entries.length, 2);
  control.removeLayer(base);
  assert.equal(control.entries.length, 1);
});

test("GridLayer, VideoOverlay and SVGOverlay expose stage four factories", () => {
  const grid = new GridLayer({ tileSize: 512, opacity: 0.5 });
  const video = videoOverlay(["a.webm", "a.mp4"], [{ lat: 55, lng: 37 }, { lat: 56, lng: 38 }], { controls: true });
  const svg = svgOverlay("<svg viewBox=\"0 0 10 10\"></svg>", [{ lat: 55, lng: 37 }, { lat: 56, lng: 38 }], { opacity: 0.6 });

  assert.ok(grid instanceof GridLayer);
  assert.equal(grid.getTileSize(), 512);
  grid.setOpacity(0.8).setZIndex(3);
  assert.equal(grid.options.opacity, 0.8);
  assert.equal(grid.options.zIndex, 3);

  assert.ok(video instanceof VideoOverlay);
  assert.deepEqual(video.urls, ["a.webm", "a.mp4"]);
  assert.equal(video.getBounds().toBBoxString(), "37,55,38,56");

  assert.ok(svg instanceof SVGOverlay);
  assert.equal(svg.getBounds().toBBoxString(), "37,55,38,56");
});

test("media overlays become interactive when a popup is bound", () => {
  const overlayBounds = [({ lat: 52.48, lng: 13.30 }), ({ lat: 52.55, lng: 13.45 })];
  const image = imageOverlay("image.png", overlayBounds).bindPopup("image");
  const video = videoOverlay("video.mp4", overlayBounds).bindPopup("video");
  const svg = svgOverlay("<svg xmlns='http://www.w3.org/2000/svg'/>", overlayBounds).bindPopup("svg");
  assert.equal(image.options.interactive, true);
  assert.equal(video.options.interactive, true);
  assert.equal(svg.options.interactive, true);
});

test("a rotated overlay keeps its bounds", () => {
  const overlayBounds = [{ lat: 52.48, lng: 13.30 }, { lat: 52.55, lng: 13.45 }];
  const image = imageOverlay("image.png", overlayBounds);
  assert.equal(image.getRotation(), 0);
  image.setRotation(30);
  assert.equal(image.getRotation(), 30);
  // Rotation is a paint step, so everything that reads the corners must be unaffected by it.
  assert.equal(image.getBounds().toBBoxString(), "13.3,52.48,13.45,52.55");
  assert.equal(videoOverlay("v.mp4", overlayBounds, { rotation: -45 }).getRotation(), -45);
  assert.equal(svgOverlay("<svg xmlns='http://www.w3.org/2000/svg'/>", overlayBounds).setRotation("nonsense").getRotation(), 0);
});
