import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  cameraWarpCoversViewport,
  cameraWarpCss,
  geoTransformCss,
  tileCornerLayerTransform,
  tileLevelWarpCss
} from "../dist/camera.js";
import { createMap } from "../dist/map.js";
import { marker } from "../dist/layers/marker.js";
import { circleMarker } from "../dist/layers/vector.js";
import { TileLayer } from "../dist/layers/tile-layer.js";
import { setTransform } from "../dist/dom.js";

function installDom(width = 800, height = 600) {
  const dom = new JSDOM("<!doctype html><div id='map'></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/"
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Image = dom.window.Image;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  const el = document.getElementById("map");
  Object.defineProperty(el, "clientWidth", { get: () => width });
  Object.defineProperty(el, "clientHeight", { get: () => height });
  el.getBoundingClientRect = () => ({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    }
  });
  return el;
}

function flushFrames(times = 2) {
  return new Promise((resolve) => {
    const step = (left) => {
      if (left <= 0) return resolve();
      setTimeout(() => step(left - 1), 0);
    };
    step(times);
  });
}

test("geo transforms keep sub-pixel precision (no Math.round)", () => {
  installDom();
  const el = document.createElement("div");
  setTransform(el, 123.438, 287.194, 1.189);
  assert.match(el.style.transform, /123\.438/);
  assert.match(el.style.transform, /287\.194/);
  assert.match(el.style.transform, /1\.189/);
  assert.equal(geoTransformCss(10.25, 20.5), "translate3d(10.25px,20.5px,0)");
});

test("camera warp matches live projection for tile corners", () => {
  const painted = { x: 1000, y: 2000 };
  const live = { x: 1050.5, y: 2010.25 };
  const css = cameraWarpCss(painted, 10, live, 10.5);
  const scale = 2 ** 0.5;
  assert.equal(css, `translate3d(${painted.x * scale - live.x}px,${painted.y * scale - live.y}px,0) scale(${scale})`);

  const corner = tileCornerLayerTransform(4, 7, 256, 10, live, 10.5);
  assert.equal(corner.scale, scale);
  assert.ok(Math.abs(corner.x - (4 * 256 * scale - live.x)) < 1e-9);
  assert.equal(corner.css, tileLevelWarpCss({ x: 4 * 256, y: 7 * 256 }, 10, live, 10.5));
});

test("camera warp coverage rejects zoom-out and pan edge gaps", () => {
  const viewport = { width: 800, height: 600 };
  const origin = { x: 1000, y: 2000 };
  assert.equal(cameraWarpCoversViewport(origin, 10, origin, 10, viewport), true);
  assert.equal(cameraWarpCoversViewport(origin, 10, origin, 9.75, viewport), false);
  assert.equal(cameraWarpCoversViewport(origin, 10, { x: 1010, y: 2000 }, 10, viewport), false);

  // Zooming around a point inside the viewport expands the old framebuffer
  // past all four edges, so the cheap CSS path remains safe.
  const scale = 2 ** 0.5;
  const anchor = { x: 300, y: 220 };
  const live = {
    x: origin.x * scale + anchor.x * (scale - 1),
    y: origin.y * scale + anchor.y * (scale - 1)
  };
  assert.equal(cameraWarpCoversViewport(origin, 10, live, 10.5, viewport), true);
});

test("fractional zoomAround keeps anchor and marker/tile math glued", async () => {
  const el = installDom();
  const map = createMap(el, {
    center: [55.7558, 37.6173],
    zoom: 10,
    zoomSnap: 0,
    wheelZoomStep: 0.25,
    controls: false,
    inertia: false
  });
  const ll = [55.76, 37.62];
  const pin = marker(ll, { shape: "circle", size: 16 }).addTo(map);
  circleMarker(ll, { radius: 6 }).addTo(map);
  const tiles = new TileLayer("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", {
    renderer: "dom",
    detectRetina: false
  }).addTo(map);

  await flushFrames(3);

  const anchor = { x: 520, y: 180 };
  const zooms = [10.25, 10.5, 10.75, 11, 11.25, 10.75, 10.5, 10.25, 10];
  for (const z of zooms) {
    const before = map.containerPointToLatLng(anchor);
    map.setZoomAround(anchor, z);
    await flushFrames(2);

    const afterPoint = map.latLngToContainerPoint(before);
    assert.ok(Math.abs(afterPoint.x - anchor.x) <= 0.5, `anchor x at z=${z}`);
    assert.ok(Math.abs(afterPoint.y - anchor.y) <= 0.5, `anchor y at z=${z}`);

    const expected = map.latLngToContainerPoint(ll);
    const markerPt = map.latLngToLayerPoint(ll);
    assert.ok(Math.abs(markerPt.x - expected.x) < 1e-9);
    assert.ok(Math.abs(markerPt.y - expected.y) < 1e-9);

    pin.render();
    tiles.render();

    const transform = pin.el.style.transform;
    assert.match(transform, /translate3d\(/);
    assert.doesNotMatch(transform, /NaN/);

    const level = tiles.level?.style.transform || "";
    assert.doesNotMatch(level, /NaN/);
    assert.ok(Number.isFinite(tiles._levelOriginX), `level origin finite at z=${z}`);

    const tileZ = tiles._tileZoom;
    assert.ok(tileZ != null);
    const world = map.crs.project(ll, tileZ);
    const tx = Math.floor(world.x / 256);
    const ty = Math.floor(world.y / 256);
    const scale = 2 ** (map.zoom - tileZ);
    const tileScreen = {
      x: tx * 256 * scale - map.pixelOrigin.x,
      y: ty * 256 * scale - map.pixelOrigin.y
    };
    const local = {
      x: (world.x - tx * 256) * scale,
      y: (world.y - ty * 256) * scale
    };
    const fromTiles = { x: tileScreen.x + local.x, y: tileScreen.y + local.y };
    assert.ok(Math.abs(fromTiles.x - expected.x) < 1e-6, `tile/marker x at z=${z}`);
    assert.ok(Math.abs(fromTiles.y - expected.y) < 1e-6, `tile/marker y at z=${z}`);

    const camera = map.getCamera();
    assert.equal(camera.zoom, map.zoom);
    assert.equal(camera.pixelOrigin.x, map.pixelOrigin.x);
  }

  map.destroy();
});

test("TileLayer zoom switch never emits NaN level transforms", async () => {
  const el = installDom();
  const map = createMap(el, {
    center: [52.52, 13.405],
    zoom: 10,
    zoomSnap: 0,
    controls: false,
    inertia: false
  });
  const tiles = new TileLayer("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", {
    renderer: "dom",
    detectRetina: false
  }).addTo(map);
  await flushFrames(2);

  map.setZoomAround({ x: 400, y: 300 }, 10.6);
  await flushFrames(2);
  // Would previously take the light path with NaN after #switchZoom.
  tiles._levelOriginX = Number.NaN;
  tiles._levelOriginY = Number.NaN;
  tiles._lastHeavyMs = Date.now();
  tiles.render();

  assert.ok(Number.isFinite(tiles._levelOriginX));
  assert.ok(Number.isFinite(tiles._levelOriginY));
  assert.doesNotMatch(tiles.level.style.transform, /NaN/);

  map.destroy();
});
