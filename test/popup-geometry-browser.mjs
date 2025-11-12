import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mime = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"]
]);
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
  const file = path.resolve(root, pathname.replace(/^\/+/, ""));
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error("Not a file");
    response.writeHead(200, { "Content-Type": mime.get(path.extname(file)) || "application/octet-stream" });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Unable to bind popup browser test server");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  await page.goto(`http://127.0.0.1:${address.port}/test/popup-geometry-browser.html`);
  await page.waitForFunction(() => document.body.dataset.state === "ready");
  const names = JSON.parse(await page.locator("#result").innerText());
  for (const name of names) {
    const target = await page.evaluate((caseName) => globalThis.popupGeometryTargets[caseName], name);
    await page.mouse.click(target.x, target.y);
    const popup = page.locator(".oh-popup");
    try {
      await popup.waitFor({ state: "visible", timeout: 5_000 });
    } catch (error) {
      throw new Error(`${name}: popup did not open at ${JSON.stringify(target)}`, { cause: error });
    }
    assert.match(await popup.innerText(), new RegExp(name, "i"), `${name} popup content`);
    await page.getByRole("button", { name: "Close popup" }).click();
  }
  const polygonTarget = await page.evaluate(() => globalThis.popupGeometryTargets.polygon);
  const beforePan = await page.evaluate(() => globalThis.popupGeometryMap.getCenter().lng);
  await page.mouse.move(polygonTarget.x, polygonTarget.y);
  await page.mouse.down();
  await page.mouse.move(polygonTarget.x + 70, polygonTarget.y + 20, { steps: 4 });
  await page.mouse.up();
  const afterPan = await page.evaluate(() => globalThis.popupGeometryMap.getCenter().lng);
  assert.notEqual(afterPan, beforePan, "map still pans when a drag starts on an interactive geometry");
  assert.equal(await page.locator(".oh-popup").count(), 0, "drag does not open a popup");
  console.log(`geometry popup browser acceptance ok (${names.join(", ")})`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
