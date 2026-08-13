import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  createEChartsPopupRenderer,
  popupConditionMatches,
  popupContent
} from "../dist/popup-content.js";

function installDom() {
  const dom = new JSDOM("<!doctype html><body><div id='host'></div></body>", { pretendToBeVisual: true });
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.requestAnimationFrame = (callback) => { callback(0); return 1; };
  globalThis.cancelAnimationFrame = () => {};
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, "play", { configurable: true, value() { this.dataset.played = "true"; return Promise.resolve(); } });
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, "pause", { configurable: true, value() { this.dataset.paused = "true"; } });
  return dom;
}

test("popupContent renders safe blocks, autoplay video and adapter charts", async () => {
  const dom = installDom();
  let chartCleanups = 0;
  const content = popupContent({
    title: "Details",
    props: { columns: 2, gap: 8 },
    children: [
      { type: "popupText", props: { text: "Hello", span: 2 } },
      { type: "popupHtml", props: { html: '<img src="javascript:alert(1)" onerror="bad()"><script>bad()</script>' } },
      { type: "popupVideo", props: { url: "clip.mp4", autoplay: true, muted: true } },
      { type: "popupChart", props: { title: "Sales" } }
    ]
  }, {
    chartRenderer: async (host) => {
      host.dataset.chart = "mounted";
      return () => { chartCleanups += 1; };
    }
  });
  const host = document.getElementById("host");
  const cleanup = await content.mount(host, { overlay: {}, map: null, latlng: null });

  assert.match(host.textContent, /Details/);
  assert.match(host.textContent, /Hello/);
  assert.equal(host.querySelector("script"), null);
  assert.equal(host.querySelector("img").hasAttribute("onerror"), false);
  assert.equal(host.querySelector("img").hasAttribute("src"), false);
  const video = host.querySelector("video");
  assert.equal(video.autoplay, true);
  assert.equal(video.muted, true);
  assert.equal(video.playsInline, true);
  assert.equal(video.dataset.played, "true");
  assert.equal(host.querySelector('[data-chart="mounted"]') !== null, true);

  cleanup();
  assert.equal(video.dataset.paused, "true");
  assert.equal(chartCleanups, 1);
  dom.window.close();
});

test("popup conditions resolve nested feature properties", () => {
  const context = { overlay: {}, map: null, latlng: null, event: { feature: { properties: { status: "open", flags: { urgent: true } } } } };
  assert.equal(popupConditionMatches("status=open", context), true);
  assert.equal(popupConditionMatches("status!=closed", context), true);
  assert.equal(popupConditionMatches("flags.urgent", context), true);
  assert.equal(popupConditionMatches("!flags.urgent", context), false);
});

test("ECharts adapter remains optional and disposes its instance", async () => {
  installDom();
  let disposed = 0;
  globalThis.echarts = {
    init() {
      return { setOption() {}, resize() {}, isDisposed: () => false, dispose() { disposed += 1; } };
    }
  };
  const host = document.createElement("div");
  document.body.append(host);
  const render = createEChartsPopupRenderer();
  const cleanup = await render(host, { type: "popupChart", props: { chartType: "gauge", values: "42" } }, { overlay: {}, map: null, latlng: null });
  cleanup();
  assert.equal(disposed, 1);
  delete globalThis.echarts;
});
