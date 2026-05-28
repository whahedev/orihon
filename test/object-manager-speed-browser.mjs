import assert from "node:assert/strict";
import { createOrihonTestServer } from "../scripts/browser-test-server.mjs";
import { chromium } from "@playwright/test";

const count = Math.max(1_000, Number(process.env.OM_SPEED_COUNT) || 25_000);
const moving = Math.max(10, Number(process.env.OM_SPEED_MOVING) || 400);
const ticks = Math.max(4, Number(process.env.OM_SPEED_TICKS) || 8);

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = String(error?.message || error);
    if (!message.includes("Executable doesn't exist")) throw error;
    for (const channel of ["msedge", "chrome"]) {
      try {
        return await chromium.launch({ headless: true, channel });
      } catch {
        /* try next */
      }
    }
    throw error;
  }
}

const server = createOrihonTestServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Unable to bind ObjectManager speed server");

const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  const url =
    `http://127.0.0.1:${address.port}/test/object-manager-speed.html` +
    `?count=${count}&moving=${moving}&ticks=${ticks}&basemap=0`;
  await page.goto(url);
  const result = await page.evaluate(async () => window.__omSpeedRun());
  assert.ok(result && !result.error, result?.error || "speed run returned no result");
  assert.equal(result.objects, count);
  assert.equal(result.moving, moving);
  assert.equal(result.validCoordinates, true, "animated updates must retain finite named coordinates");
  assert.equal(result.positionChanged, true, "the benchmark must actually move its objects");
  assert.ok(result.ingestMs < 4_000, `ingest too slow: ${result.ingestMs}ms`);
  assert.ok(result.layoutMs < 1_500, `layout too slow: ${result.layoutMs}ms`);
  assert.ok(result.animateAvgMs < 80, `animate subset too slow: ${result.animateAvgMs}ms`);

  // A run that moves points nobody can see reads as a broken animation: the camera used to sit
  // on a fixed view that held five of the five hundred moving points. Checked on a fresh load,
  // before the animation has had time to scatter them.
  await page.click("#run");
  await page.waitForFunction(() => document.body.dataset.state === "loaded");
  const framed = await page.evaluate(() => {
    const { map, manager } = window.__omDebug;
    const view = map.getBounds();
    const sample = Math.min(200, manager.getStats().objects);
    let inside = 0;
    for (let i = 0; i < sample; i++) {
      const at = manager.getObject(i)?.coordinates;
      if (!at) continue;
      if (at.lat >= view.south && at.lat <= view.north && at.lng >= view.west && at.lng <= view.east) inside += 1;
    }
    return { inside, sample };
  });
  assert.equal(
    framed.inside,
    framed.sample,
    `after Load only ${framed.inside} of ${framed.sample} animated points are on screen`
  );

  // Moving a point uploads new coordinates to the GPU, and `render()` used to drop the repaint
  // whenever the camera had not moved — so the animation only appeared on the next zoom or pan.
  // Counting draw calls is the only way to tell a running animation from a frozen picture.
  await page.evaluate(() => {
    const canvas = document.querySelector("#map canvas.oh-webgl-point-layer");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    window.__draws = 0;
    for (const name of ["drawArrays", "drawElements"]) {
      const original = gl[name].bind(gl);
      gl[name] = (...args) => { window.__draws += 1; return original(...args); };
    }
  });
  await page.click("#animate");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const draws = await page.evaluate(() => window.__draws);
  await page.click("#stop");
  assert.ok(draws > 2, `the animation drew ${draws} frames in 1.2s; it is not repainting`);

  // The buttons take a different path than __omSpeedRun: the live animation ticks on its own
  // timer while a measurement is running. It used to write over the results panel, so pressing
  // Pan while animating produced numbers nobody could read.
  await page.click("#animate");
  await page.click("#pan");
  await page.waitForFunction(() => document.getElementById("stats").textContent.includes("pan "));
  const panels = await page.evaluate(() => ({
    stats: document.getElementById("stats").textContent,
    live: document.getElementById("live").textContent
  }));
  assert.match(panels.stats, /pan [0-9]/, "pan result stays readable while the animation runs");
  assert.match(panels.stats, /ingest [0-9]/, "the load measurements are not wiped by a later run");
  assert.match(panels.live, /animating /, "the live line reports the running animation");
  console.log(
    `ObjectManager speed ok · ${count} pts · move ${moving} · ` +
      `ingest ${result.ingestMs.toFixed(0)}ms · layout ${result.layoutMs.toFixed(0)}ms · ` +
      `animate avg ${result.animateAvgMs.toFixed(1)}ms max ${result.animateMaxMs.toFixed(1)}ms` +
      (result.heapMb != null ? ` · heap ${result.heapMb.toFixed(0)}MB` : "")
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
