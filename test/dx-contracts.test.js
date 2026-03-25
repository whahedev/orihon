import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  createMap,
  tileLayer,
  DestroyedError,
  OrihonError,
  UnsupportedCapabilityError
} from "../dist/core.js";
import { offlineTileCache } from "../dist/services/offline-cache.js";

function installDom(width = 800, height = 600) {
  const dom = new JSDOM("<!doctype html><div id='map'></div>", { pretendToBeVisual: true, url: "http://localhost/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Image = dom.window.Image;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  const el = document.getElementById("map");
  Object.defineProperty(el, "clientWidth", { get: () => width });
  Object.defineProperty(el, "clientHeight", { get: () => height });
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height });
  return el;
}

test("everything that attaches to a destroyed map fails with one discriminable error", () => {
  const el = installDom();
  const map = createMap(el, { center: { lat: 0, lng: 0 }, zoom: 2, controls: false });
  map.destroy();
  map.destroy(); // terminal and idempotent

  for (const attach of [
    () => map.addLayer(tileLayer("https://tiles.test/{z}/{x}/{y}.png")),
    () => map.createPane("extra")
  ]) {
    assert.throws(attach, (error) => {
      assert.ok(error instanceof DestroyedError);
      assert.ok(error instanceof OrihonError);
      assert.equal(error.code, "ERR_DESTROYED");
      return true;
    });
  }

  // Camera and query stay inert rather than throwing — the documented other half of the contract.
  assert.equal(map.setView({ lat: 1, lng: 1 }, 5), map);
  assert.equal(map.getZoom(), 2);
});

test("Core layers do not advertise popup binding, and asking for it names the missing tier", () => {
  const el = installDom();
  const map = createMap(el, { center: { lat: 0, lng: 0 }, zoom: 2, controls: false });
  const tiles = tileLayer("https://tiles.test/{z}/{x}/{y}.png").addTo(map);
  assert.equal("bindPopup" in tiles, false);
  assert.equal("bindTooltip" in tiles, false);

  const error = new UnsupportedCapabilityError("Popup module is not registered");
  assert.ok(error instanceof OrihonError);
  assert.equal(error.code, "ERR_UNSUPPORTED_CAPABILITY");
  map.destroy();
});

test("Core resolves the requested locale through localeReady", async () => {
  const el = installDom();
  const map = createMap(el, { center: { lat: 0, lng: 0 }, zoom: 2, locale: "ru" });

  // Synchronously the map already reports the requested language, with English stand-in strings.
  assert.equal(map.locale.language, "ru");
  await map.localeReady;
  assert.equal(map.locale.layers, "Слои");

  await map.setLocale("de").localeReady;
  assert.equal(map.locale.language, "de");
  assert.equal(map.locale.locate, "Meinen Standort anzeigen");

  // English needs no pack, so readiness is already settled.
  await map.setLocale("en").localeReady;
  assert.equal(map.locale.mapLabel, "Interactive map");
  map.destroy();
});

test("offline prefetch reports the URL, stage and cause of every lost tile", async () => {
  const originalCaches = globalThis.caches;
  const quota = new Error("QuotaExceededError");
  const offline = new Error("Failed to fetch");
  globalThis.caches = {
    async open() {
      return {
        async put(url) { if (String(url).includes("full")) throw quota; },
        async match() { return undefined; }
      };
    }
  };
  try {
    const failures = [];
    const cache = offlineTileCache({
      urlPrefixes: ["https://tiles.example/"],
      onError: (failure) => failures.push(failure),
      fetcher: async (url) => {
        if (url.includes("down")) throw offline;
        return new Response("tile");
      }
    });
    const stats = await cache.prefetch([
      "https://tiles.example/ok.png",
      "https://tiles.example/down.png",
      "https://tiles.example/full.png",
      "https://evil.example/blocked.png"
    ]);

    assert.equal(stats.cached, 1);
    assert.equal(stats.failed, 3);
    assert.deepEqual(
      failures.map((failure) => [failure.stage, failure.url]).sort(),
      [
        ["cache", "https://tiles.example/full.png"],
        ["fetch", "https://tiles.example/down.png"],
        ["url", "https://evil.example/blocked.png"]
      ]
    );
    assert.equal(failures.find((failure) => failure.stage === "fetch").cause, offline);
    assert.equal(failures.find((failure) => failure.stage === "cache").cause, quota);
    assert.equal(failures.find((failure) => failure.stage === "url").cause, undefined);
  } finally {
    globalThis.caches = originalCaches;
  }
});

test("a throwing onError never turns one lost tile into a failed prefetch", async () => {
  const cache = offlineTileCache({
    fetcher: undefined,
    urlPrefixes: ["https://tiles.example/"],
    onError: () => { throw new Error("diagnostics blew up"); }
  });
  const stats = await cache.prefetch(["https://evil.example/a.png"]);
  assert.equal(stats.failed, 1);
  assert.throws(() => offlineTileCache({ onError: "nope" }), TypeError);
});
