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

const buttons = await page.getByRole("button").evaluateAll((els) => els.map((e) => ({
  name: (e.getAttribute("aria-label") || e.innerText).slice(0, 100),
  cls: e.className.slice(0, 80)
})).filter((b) => /studio|marker|place|moscow|places/i.test(b.name)));
console.log("matching buttons", JSON.stringify(buttons, null, 2));

const studio = page.getByRole("button", { name: "Studio marker" });
console.log("studio count", await studio.count());
if (await studio.count()) {
  console.log("matched", await studio.first().evaluate((e) => ({
    tag: e.tagName,
    cls: e.className,
    aria: e.getAttribute("aria-label"),
    text: e.innerText,
    title: e.getAttribute("title")
  })));
}

await page.getByRole("button", { name: "Places Object layer" }).click();
await page.getByRole("button", { name: "Place Marker in selected object" }).click();
console.log("after place start", await page.evaluate(() => ({
  placing: document.getElementById("map")?.classList.contains("studio-placing"),
  markers: document.querySelectorAll(".oh-marker").length,
  popups: document.querySelectorAll(".oh-popup").length,
  status: document.querySelector("[role=status]")?.textContent
})));

const markerBox = await page.locator(".oh-marker").first().boundingBox();
console.log("markerBox", markerBox);
if (markerBox) {
  await page.mouse.click(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
  await page.waitForTimeout(100);
  console.log("after map click on marker", await page.evaluate(() => ({
    placing: document.getElementById("map")?.classList.contains("studio-placing"),
    markers: document.querySelectorAll(".oh-marker").length,
    popups: document.querySelectorAll(".oh-popup").length,
    status: document.querySelector("[role=status]")?.textContent
  })));
}

await browser.close();
await new Promise((r) => server.close(r));
