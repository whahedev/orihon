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

  // Overdraw counts as coverage. A layer that paints a padded surface would otherwise be told
  // to repaint for a pan its own margin already covers — at a million points that repaint
  // overruns the frame budget, and the repaint path resets the CSS transform, so the stale
  // surface is composited unwarped for a frame and the content visibly jumps.
  const pad = 96;
  const panned = { x: origin.x + 40, y: origin.y + 40 };
  assert.equal(cameraWarpCoversViewport(origin, 10, panned, 10, viewport), false, "no pad: a 40px pan uncovers");
  assert.equal(cameraWarpCoversViewport(origin, 10, panned, 10, viewport, undefined, pad), true, "the pad absorbs it");
  // The pad is finite: a pan past it still forces the repaint.
  const far = { x: origin.x + pad + 10, y: origin.y };
  assert.equal(cameraWarpCoversViewport(origin, 10, far, 10, viewport, undefined, pad), false);
  // Default stays exactly as before for surfaces painted at viewport size.
  assert.equal(cameraWarpCoversViewport(origin, 10, origin, 9.75, viewport, undefined, 0), false);
});

test("fractional zoomAround keeps anchor and marker/tile math glued", async () => {
  const el = installDom();
  const map = createMap(el, {
    center: { lat: 55.7558, lng: 37.6173 },
    zoom: 10,
    zoomSnap: 0,
    wheelZoomStep: 0.25,
    controls: false,
    inertia: false
  });
  const ll = [55.76, 37.62];
  const pin = marker({ lat: ll[0], lng: ll[1] }, { shape: "circle", size: 16 }).addTo(map);
  circleMarker({ lat: ll[0], lng: ll[1] }, { radiusPixels: 6 }).addTo(map);
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

    const expected = map.latLngToContainerPoint({ lat: ll[0], lng: ll[1] });
    const markerPt = map.latLngToLayerPoint({ lat: ll[0], lng: ll[1] });
    assert.ok(Math.abs(markerPt.x - expected.x) < 1e-9);
    assert.ok(Math.abs(markerPt.y - expected.y) < 1e-9);

    pin.render();
    tiles.render();

    const transform = pin.el.style.transform;
    assert.match(transform, /translate3d\(/);
    assert.doesNotMatch(transform, /NaN/);

    const level = map.panes.tile.querySelector(".oh-tile-level")?.style.transform || "";
    assert.doesNotMatch(level, /NaN/, `level transform finite at z=${z}`);

    const tileZ = tiles.getStats().tileZoom;
    assert.ok(tileZ != null);
    const world = map.crs.project({ lat: ll[0], lng: ll[1] }, tileZ);
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
    center: { lat: 52.52, lng: 13.405 },
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

  const levelTransform = () => map.panes.tile.querySelector(".oh-tile-level").style.transform;

  map.setZoomAround({ x: 400, y: 300 }, 10.6);
  await flushFrames(2);
  assert.doesNotMatch(levelTransform(), /NaN/);

  // A settled continuous zoom runs the deferred #switchZoom, which invalidates the level snap.
  // The very next render() is inside the heavy-path throttle window, so it takes the light path:
  // that path must recompute the origin instead of warping the level with the stale NaN.
  map.setZoomAround({ x: 400, y: 300 }, 11.4);
  await flushFrames(2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(tiles.getStats().tileZoom, 11, "deferred zoom switch adopts the settled source zoom");
  tiles.render();

  assert.doesNotMatch(levelTransform(), /NaN/);

  map.destroy();
});
