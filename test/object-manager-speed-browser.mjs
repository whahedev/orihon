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
    `?count=${count}&moving=${moving}&ticks=${ticks}`;
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
