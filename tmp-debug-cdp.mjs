import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(".");
const mime = new Map([[".css", "text/css"], [".html", "text/html"], [".js", "text/javascript"], [".mjs", "text/javascript"]]);
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
  const relative = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
  const file = path.resolve(root, relative.replace(/^\/+/, ""));
  try {
    if (!(await stat(file)).isFile()) throw new Error("nf");
    res.writeHead(200, { "Content-Type": mime.get(path.extname(file)) || "application/octet-stream" });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end("nf");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://127.0.0.1:${port}/_local/studio/`);
await page.evaluate(() => sessionStorage.clear());
await page.reload();
await page.waitForTimeout(400);

// Instrument placement handlers
await page.evaluate(() => {
  window.__log = [];
  const mapEl = document.getElementById("map");
  for (const type of ["pointerdown", "pointerup", "click"]) {
    mapEl.addEventListener(type, (event) => {
      window.__log.push({
        phase: "bubble",
        type,
        target: event.target?.className || event.target?.tagName,
        defaultPrevented: event.defaultPrevented,
        placing: mapEl.classList.contains("studio-placing")
      });
    }, false);
    mapEl.addEventListener(type, (event) => {
      window.__log.push({
        phase: "capture-early",
        type,
        target: event.target?.className || event.target?.tagName,
        defaultPrevented: event.defaultPrevented,
        placing: mapEl.classList.contains("studio-placing")
      });
    }, { capture: true });
  }
});

await page.getByRole("button", { name: "Places Object layer" }).click();
await page.getByRole("button", { name: "Place Marker in selected object" }).click();

const box = await page.locator("#map").boundingBox();
const x = box.x + box.width * 0.4;
const y = box.y + box.height * 0.4;

// Use CDP for realish mouse events
const client = await page.context().newCDPSession(page);
await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
await page.waitForTimeout(200);

const result = await page.evaluate(() => ({
  log: window.__log,
  markers: document.querySelectorAll("button.oh-marker").length,
  sceneMarkers: [...document.querySelectorAll("button.scene-node")].filter((b) => /Marker/i.test(b.innerText)).map((b) => b.innerText.replace(/\s+/g, " ")),
  placing: document.getElementById("map").classList.contains("studio-placing"),
  status: document.getElementById("status")?.textContent
}));
console.log(JSON.stringify(result, null, 2));

await browser.close();
await new Promise((r) => server.close(r));
