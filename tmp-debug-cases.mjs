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

async function count() {
  return page.evaluate(() => ({
    placing: document.getElementById("map")?.classList.contains("studio-placing"),
    markers: document.querySelectorAll("button.oh-marker").length,
    scene: [...document.querySelectorAll("button.scene-node")].map((b) => b.innerText.replace(/\s+/g, " ").trim()),
    popups: document.querySelectorAll(".oh-popup").length,
    hud: document.getElementById("placement-hud")?.hidden
  }));
}

const box = await page.locator("#map").boundingBox();

console.log("start", await count());

// Case A: empty map placement
await page.getByRole("button", { name: "Places Object layer" }).click();
await page.getByRole("button", { name: "Place Marker in selected object" }).click();
await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.25);
await page.waitForTimeout(120);
console.log("A empty map", await count());

// Case B: on existing marker (with popup)
await page.getByRole("button", { name: "Places Object layer" }).click();
await page.getByRole("button", { name: "Place Marker in selected object" }).click();
const marker = page.locator("button.oh-marker").first();
const mb = await marker.boundingBox();
await page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2);
await page.waitForTimeout(120);
console.log("B on marker", await count());

// Case C: create circle+popup, leave popup open, place marker into circle/popup
await page.getByRole("button", { name: "Places Object layer" }).click();
await page.getByRole("button", { name: "Place Circle in selected object" }).click();
const cx = box.x + box.width * 0.7;
const cy = box.y + box.height * 0.65;
await page.mouse.click(cx, cy);
await page.mouse.click(cx + 70, cy);
await page.waitForTimeout(100);
await page.locator("button.scene-node", { hasText: "Circle" }).last().click();
await page.getByRole("button", { name: "Add Popup in selected object" }).click();
await page.mouse.click(cx + 10, cy + 5);
await page.waitForTimeout(100);
console.log("C popup open", await count());

await page.getByRole("button", { name: "Places Object layer" }).click();
await page.getByRole("button", { name: "Place Marker in selected object" }).click();
console.log("C placing armed", await count());
await page.mouse.click(cx + 10, cy + 5);
await page.waitForTimeout(150);
console.log("C click on open popup/circle", await count());

// Case D: pointerdown/up with slight move > 7
await page.getByRole("button", { name: "Places Object layer" }).click();
await page.getByRole("button", { name: "Place Marker in selected object" }).click();
await page.mouse.move(box.x + 100, box.y + 100);
await page.mouse.down();
await page.mouse.move(box.x + 120, box.y + 100);
await page.mouse.up();
await page.waitForTimeout(120);
console.log("D moved >7px", await count());

await browser.close();
await new Promise((r) => server.close(r));
