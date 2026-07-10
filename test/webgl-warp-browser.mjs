import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createOrihonTestServer } from "../scripts/browser-test-server.mjs";

const server = createOrihonTestServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Unable to bind WebGL warp browser server");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);

  const result = await page.evaluate(async () => {
    const api = await import("/dist/orihon.esm.js");
    const host = document.createElement("div");
    host.style.cssText = "width:640px;height:480px";
    document.body.appendChild(host);
    const map = api.createMap(host, { center: { lat: 50, lng: 10 }, zoom: 5, controls: false });

    // The overscan pad is only allocated above 8,000 points, and the pad is what the warp has to
    // account for — a smaller layer cannot show this at all.
    const points = [];
    for (let i = 0; i < 12_000; i += 1) {
      points.push({ lat: 45 + (i % 100) * 0.1, lng: 5 + Math.floor(i / 100) * 0.1 });
    }
    const layer = api.webglPointLayer(points, { pointSize: 3, color: "#0f766e" }).addTo(map);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const canvas = layer.canvas;
    const probe = { lat: 48.5, lng: 8.5 };
    const readTransform = () => {
      const raw = canvas.style.transform;
      const move = /translate3d\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(raw);
      const scale = /scale\(\s*(-?[\d.]+)/.exec(raw);
      if (!move) return null;
      return { tx: Number(move[1]), ty: Number(move[2]), scale: scale ? Number(scale[1]) : 1, raw };
    };

    /**
     * Where the warped surface actually puts `probe`, from the canvas offset and its transform,
     * against where the live camera says it belongs. A correct warp keeps the two together.
     */
    const offsetAfter = async (nextZoom) => {
      map.updateView({ lat: 50, lng: 10 }, 5);
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Read through the DOM and the public camera rather than the layer's fields: the published
      // bundle is minified, so anything named with an underscore is gone by the time this runs.
      // After a settled repaint the canvas offset is the pad, and the live camera is the painted one.
      const pad = Math.abs(Number.parseFloat(canvas.style.left)) || 0;
      const paintedZoom = map.zoom;
      const paintedOrigin = { x: map.pixelOrigin.x, y: map.pixelOrigin.y };
      map.updateView({ lat: 50, lng: 10 }, nextZoom);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const transform = readTransform();
      if (!transform) return { skipped: "no warp transform", pad };
      const absolute = api.project(probe, paintedZoom);
      const local = { x: absolute.x - paintedOrigin.x + pad, y: absolute.y - paintedOrigin.y + pad };
      const drawn = {
        x: -pad + transform.tx + local.x * transform.scale,
        y: -pad + transform.ty + local.y * transform.scale
      };
      const expected = map.latLngToContainerPoint(probe);
      return {
        pad,
        scale: transform.scale,
        dx: drawn.x - expected.x,
        dy: drawn.y - expected.y
      };
    };

    return { zoomedIn: await offsetAfter(6), zoomedOut: await offsetAfter(4) };
  });

// Zooming out can leave the painted surface short of the viewport, which repaints instead of
// warping; that is correct and simply has nothing to measure. Assert on the warps that happened.
const warped = Object.entries(result).filter(([, measured]) => !measured.skipped);
assert.ok(warped.length > 0, `no zoom produced a warp: ${JSON.stringify(result)}`);

for (const [name, measured] of warped) {
  assert.ok(measured.pad > 0, `${name}: expected an overscan pad, got ${measured.pad}`);
  assert.notEqual(measured.scale, 1, `${name}: expected a scaled warp, got ${measured.scale}`);
  // Before the pad term was added this was exactly pad * (scale - 1): 120 px zooming in.
  assert.ok(
    Math.abs(measured.dx) < 0.5 && Math.abs(measured.dy) < 0.5,
    `${name}: warped points sit ${measured.dx.toFixed(1)},${measured.dy.toFixed(1)} px from their projection`
  );
}

  console.log("webgl warp browser checks passed", JSON.stringify(result));
} finally {
  await browser.close();
  server.close();
}
