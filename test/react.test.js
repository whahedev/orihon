import test from "node:test";
import assert from "node:assert/strict";
import React, { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Map as OrihonMap } from "../dist/react/map.js";
import { ObjectManager } from "../dist/react/object-manager.js";

test("React Map survives Strict Mode without leaking map instances", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  let creates = 0;
  let removes = 0;
  let current;
  const ready = (map) => {
    creates++;
    current = map;
    const original = map.remove.bind(map);
    map.remove = () => { removes++; return original(); };
  };
  const root = createRoot(document.getElementById("root"));
  await act(async () => {
    root.render(React.createElement(StrictMode, null,
      React.createElement(OrihonMap, { center: { lat: 10, lng: 20 }, zoom: 4, controls: false, onMapReady: ready, style: { height: 300 } })
    ));
  });
  assert.equal(creates, 2);
  assert.equal(removes, 1);
  assert.equal(document.querySelectorAll(".oh-viewport").length, 1);

  await act(async () => {
    root.render(React.createElement(StrictMode, null,
      React.createElement(OrihonMap, { center: { lat: 11, lng: 21 }, zoom: 5, controls: false, onMapReady: ready, style: { height: 300 } })
    ));
  });
  assert.equal(creates, 2);
  assert.equal(current.getZoom(), 5);
  assert.ok(current.getCenter().equals({ lat: 11, lng: 21 }));

  await act(async () => { root.unmount(); });
  assert.equal(removes, 2);
  assert.equal(document.querySelectorAll(".oh-viewport").length, 0);
  dom.window.close();
  delete globalThis.ResizeObserver;
});

test("React ObjectManager keeps id-diffed objects through Strict Mode replay", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let manager;
  const objects = [{ id: 1, coordinates: ({ lat: 10, lng: 20 }) }, { id: 2, coordinates: ({ lat: 11, lng: 21 }) }];
  const root = createRoot(document.getElementById("root"));
  await act(async () => {
    root.render(React.createElement(StrictMode, null,
      React.createElement(OrihonMap, { center: { lat: 10, lng: 20 }, zoom: 4, controls: false },
        React.createElement(ObjectManager, { objects, clusterRenderer: "dom", onReady: (value) => { manager = value; } })
      )
    ));
  });
  assert.equal(manager.getObjects().length, 2);
  await act(async () => { root.unmount(); });
  assert.equal(manager.map, null);
  dom.window.close();
  delete globalThis.ResizeObserver;
});
