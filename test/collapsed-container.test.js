import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createMap } from "../dist/map.js";

// jsdom lays nothing out, so every element reports a zero box. The check treats that as "no
// layout engine" and stays quiet; these tests give the document a size so the distinction between
// a genuinely collapsed container and an environment without layout is the thing under test.
function installDom({ containerHeight, documentHeight = 768, display = "block" } = {}) {
  const dom = new JSDOM("<!doctype html><div id='map'></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/"
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Image = dom.window.Image;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  const rect = (width, height) => () => ({
    width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({})
  });
  dom.window.document.documentElement.getBoundingClientRect = rect(1024, documentHeight);

  const element = dom.window.document.getElementById("map");
  element.getBoundingClientRect = rect(800, containerHeight);
  Object.defineProperty(element, "clientWidth", { get: () => 800 });
  Object.defineProperty(element, "clientHeight", { get: () => containerHeight });
  const computed = dom.window.getComputedStyle.bind(dom.window);
  dom.window.getComputedStyle = (target, pseudo) => {
    if (target !== element) return computed(target, pseudo);
    return { ...computed(target, pseudo), display };
  };

  const warnings = [];
  dom.window.console.warn = (message) => warnings.push(String(message));
  return { element, warnings, window: dom.window };
}

/** The check runs on the window's own rAF, which jsdom drives on a ~16ms visual clock. */
function nextFrame() {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

test("a container with no height is reported once, with the selector and a way out", async () => {
  const { element, warnings } = installDom({ containerHeight: 0 });
  const map = createMap(element, { center: { lat: 55.75, lng: 37.62 }, zoom: 9 });
  await nextFrame();

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /zero height/);
  assert.match(warnings[0], /#map \{ height: 400px \}/);
  assert.match(warnings[0], /TROUBLESHOOTING\.md#zero-size-container/);
  map.destroy();
});

test("a container that has a height is never reported", async () => {
  const { element, warnings } = installDom({ containerHeight: 600 });
  const map = createMap(element, { center: { lat: 55.75, lng: 37.62 }, zoom: 9 });
  await nextFrame();

  assert.deepEqual(warnings, []);
  map.destroy();
});

test("a deliberately hidden map is not a layout mistake", async () => {
  const { element, warnings } = installDom({ containerHeight: 0, display: "none" });
  const map = createMap(element, { center: { lat: 55.75, lng: 37.62 }, zoom: 9 });
  await nextFrame();

  assert.deepEqual(warnings, []);
  map.destroy();
});

test("an environment without layout says nothing about the container", async () => {
  const { element, warnings } = installDom({ containerHeight: 0, documentHeight: 0 });
  const map = createMap(element, { center: { lat: 55.75, lng: 37.62 }, zoom: 9 });
  await nextFrame();

  assert.deepEqual(warnings, []);
  map.destroy();
});

test("a map destroyed before the check runs stays silent", async () => {
  const { element, warnings } = installDom({ containerHeight: 0 });
  const map = createMap(element, { center: { lat: 55.75, lng: 37.62 }, zoom: 9 });
  map.destroy();
  await nextFrame();

  assert.deepEqual(warnings, []);
});
