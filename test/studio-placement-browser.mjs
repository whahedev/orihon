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
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"]
]);
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
  const relative = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
  const file = path.resolve(root, relative.replace(/^\/+/, ""));
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": mime.get(path.extname(file)) || "application/octet-stream"
    });
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
if (!address || typeof address === "string") throw new Error("Unable to bind Studio browser test server");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${address.port}/_local/studio/`);
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.waitForTimeout(300);

  const sceneMarkers = () => page.locator("button.scene-node").evaluateAll((nodes) => (
    nodes.filter((node) => /\bMarker\b/i.test(node.innerText)).length
  ));

  const map = page.locator("#map");
  const box = await map.boundingBox();
  assert.ok(box, "map is visible");

  // 1) Place marker on top of the starter marker that owns a popup.
  await page.getByRole("button", { name: "Places Object layer" }).click();
  await page.getByRole("button", { name: "Place Marker in selected object" }).click();
  assert.equal(await page.locator("#map.studio-placing").count(), 1, "placement mode is armed");

  const starter = page.locator("button.oh-marker").first();
  const starterBox = await starter.boundingBox();
  assert.ok(starterBox, "starter marker is on the map");
  const beforeStarter = await sceneMarkers();
  await page.mouse.click(starterBox.x + starterBox.width / 2, starterBox.y + starterBox.height / 2);
  await page.waitForTimeout(80);

  assert.equal(await sceneMarkers(), beforeStarter + 1, "the new marker is placed over the popup owner");
  assert.equal(await page.locator(".oh-popup").count(), 0, "the underlying marker popup remains closed");
  await expectText(page.locator("#status"), /Marker placed/);

  // 2) Place a circle with a popup, then place another marker inside the circle fill.
  await page.getByRole("button", { name: "Places Object layer" }).click();
  await page.getByRole("button", { name: "Place Circle in selected object" }).click();
  const cx = box.x + box.width * 0.62;
  const cy = box.y + box.height * 0.58;
  await page.mouse.click(cx, cy);
  await page.mouse.click(cx + 90, cy);
  await page.waitForTimeout(100);

  await page.locator("button.scene-node", { hasText: "Circle" }).last().click();
  await page.getByRole("button", { name: "Add Popup in selected object" }).click();
  await page.mouse.click(cx + 20, cy + 10);
  await page.waitForTimeout(80);
  assert.equal(await page.locator(".oh-popup").count(), 1, "circle popup opens when not placing");

  const beforeCircle = await sceneMarkers();
  await page.getByRole("button", { name: "Places Object layer" }).click();
  await page.getByRole("button", { name: "Place Marker in selected object" }).click();
  assert.equal(await page.locator(".oh-popup").count(), 0, "open popups close when placement starts");
  await page.mouse.click(cx + 20, cy + 10);
  await page.waitForTimeout(100);

  assert.equal(await sceneMarkers(), beforeCircle + 1, "marker is placed inside the circle");
  assert.equal(await page.locator(".oh-popup").count(), 0, "circle popup does not open during placement");
  assert.equal(await page.locator("#map.studio-placing").count(), 0, "placement mode ends after the marker");
  await expectText(page.locator("#status"), /Marker placed/);

  // 3) Empty-map placement still works after the popup cases.
  await page.getByRole("button", { name: "Places Object layer" }).click();
  await page.getByRole("button", { name: "Place Marker in selected object" }).click();
  const beforeEmpty = await sceneMarkers();
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.25);
  await page.waitForTimeout(80);
  assert.equal(await sceneMarkers(), beforeEmpty + 1, "marker places on empty map");

  console.log("Studio placement popup suppression ok");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

async function expectText(locator, pattern) {
  const value = await locator.innerText();
  assert.match(value, pattern);
}
