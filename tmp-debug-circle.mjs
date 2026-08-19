import assert from "node:assert/strict";
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
page.on("console", (msg) => console.log("BROWSER:", msg.type(), msg.text()));

await page.goto(`http://127.0.0.1:${port}/_local/studio/`);
await page.evaluate(() => sessionStorage.clear());
await page.reload();
await page.waitForTimeout(400);

await page.getByRole("button", { name: "Places Object layer" }).click();
await page.getByRole("button", { name: "Place Circle in selected object" }).click();
const box = await page.locator("#map").boundingBox();
const cx = box.x + box.width * 0.55;
const cy = box.y + box.height * 0.55;
await page.mouse.click(cx, cy);
await page.mouse.click(cx + 90, cy);
await page.waitForTimeout(150);

await page.locator("button.scene-node", { hasText: "Circle" }).last().click();
await page.getByRole("button", { name: "Add Popup in selected object" }).click();
await page.waitForTimeout(80);

// Close any open popup by clicking far away empty map area
await page.mouse.click(box.x + 40, box.y + 40);
await page.waitForTimeout(80);

const before = await page.evaluate(() => ({
  markers: document.querySelectorAll(".oh-marker").length,
  popups: document.querySelectorAll(".oh-popup").length,
  sceneMarkers: [...document.querySelectorAll("button.scene-node")].filter((b) => /Marker/i.test(b.innerText)).length
}));
console.log("before", before);

await page.getByRole("button", { name: "Places Object layer" }).click();
await page.getByRole("button", { name: "Place Marker in selected object" }).click();
await page.waitForTimeout(50);

// Click inside circle fill (not on popup)
await page.mouse.click(cx + 25, cy + 15);
await page.waitForTimeout(200);

const after = await page.evaluate(() => ({
  placing: document.getElementById("map")?.classList.contains("studio-placing"),
  markers: document.querySelectorAll(".oh-marker").length,
  popups: document.querySelectorAll(".oh-popup").length,
  sceneMarkers: [...document.querySelectorAll("button.scene-node")].map((b) => b.innerText.replace(/\s+/g, " ").trim()).filter((t) => /marker/i.test(t)),
  status: document.getElementById("map-status")?.textContent?.replace(/\s+/g, " ").trim()
}));
console.log("after", after);

await browser.close();
await new Promise((r) => server.close(r));
