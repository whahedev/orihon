import { test, expect } from "@playwright/test";

async function loadVisualMap(page) {
  await page.goto("/test/fixtures/visual.html");
  await page.waitForFunction(() => window.__orihonVisual?.ready === true);
}

test("standalone IIFE renders canvas, vectors and markers", async ({ page }) => {
  await loadVisualMap(page);
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator(".oh-canvas-base")).toHaveCount(1);
  await expect(page.locator(".oh-svg-layer path")).toHaveCount(2);
  await expect(page.locator(".oh-svg-layer circle")).toHaveCount(1);
  await expect(page.locator(".oh-marker")).toHaveCount(1);

  const canvas = await page.locator(".oh-canvas-base").evaluate((element) => {
    const context = element.getContext("2d");
    const data = context.getImageData(0, 0, element.width, element.height).data;
    const colors = new Set();
    let opaque = 0;
    const stride = Math.max(4, Math.floor(data.length / 20_000 / 4) * 4);
    for (let index = 0; index < data.length; index += stride) {
      if (data[index + 3] > 0) opaque += 1;
      colors.add(`${data[index]},${data[index + 1]},${data[index + 2]},${data[index + 3]}`);
    }
    return { colors: colors.size, opaque };
  });
  expect(canvas.colors).toBeGreaterThan(5);
  expect(canvas.opaque).toBeGreaterThan(1000);

  const mapBox = await page.locator("#map").boundingBox();
  const markerBox = await page.locator(".oh-marker").boundingBox();
  expect(mapBox).not.toBeNull();
  expect(markerBox).not.toBeNull();
  expect(markerBox.x).toBeGreaterThanOrEqual(mapBox.x);
  expect(markerBox.y).toBeGreaterThanOrEqual(mapBox.y);
  expect(markerBox.x + markerBox.width).toBeLessThanOrEqual(mapBox.x + mapBox.width);
  expect(markerBox.y + markerBox.height).toBeLessThanOrEqual(mapBox.y + mapBox.height);
});

test("vector screen geometry matches the visual regression contract", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "Desktop geometry has a fixed 800x500 viewport");
  await loadVisualMap(page);
  const signature = await page.evaluate(() => {
    const map = window.__orihonVisual.map;
    const markerEl = document.querySelector(".oh-marker");
    const expected = map.latLngToLayerPoint([52.53, 13.42]);
    // Default pin metrics: size 22 → width 24, height 36, anchor [12, 36]
    const transform = markerEl?.style.transform || "";
    const match = transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/);
    const tx = match ? Number(match[1]) : NaN;
    const ty = match ? Number(match[2]) : NaN;
    const circle = document.querySelector(".oh-svg-layer circle");
    return {
      center: map.latLngToContainerPoint([52.52, 13.405]).toArray(),
      viewBox: document.querySelector(".oh-svg-layer")?.getAttribute("viewBox"),
      paths: [...document.querySelectorAll(".oh-svg-layer path")].map((path) => path.getAttribute("d")),
      circle: circle
        ? { cx: Number(circle.getAttribute("cx")), cy: Number(circle.getAttribute("cy")), r: Number(circle.getAttribute("r")) }
        : null,
      markerDx: Math.abs(tx - (expected.x - 12)),
      markerDy: Math.abs(ty - (expected.y - 36)),
      roundedLegacy: /translate3d\(\d+px,\s*\d+px/.test(transform)
    };
  });

  expect(signature.center).toEqual([400, 250]);
  expect(signature.viewBox).toBe("0 0 800 500");
  expect(signature.paths).toEqual([
    "M360.0 285.9L403.6 238.0L425.5 273.9",
    "M381.8 262.0L389.1 226.1L425.5 232.0L418.2 267.9Z"
  ]);
  expect(signature.circle).toEqual({ cx: 400, cy: 250, r: 9 });
  expect(signature.markerDx).toBeLessThanOrEqual(0.01);
  expect(signature.markerDy).toBeLessThanOrEqual(0.01);
  expect(signature.roundedLegacy).toBe(false);
});

test("continuous wheel zoom keeps markers glued to camera projection", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "Desktop wheel zoom");
  await page.goto("/test/fixtures/camera-sync.html");
  await page.waitForFunction(() => window.__orihonCameraSync?.ready === true);

  const report = await page.evaluate(async () => window.__orihonCameraSync.autoWheel(24));
  expect(report.samples).toBe(24);
  expect(report.maxError).toBeLessThanOrEqual(0.75);
});

test("tiles and overlays stay viewport-local at maximum zoom", async ({ page }) => {
  await loadVisualMap(page);
  await page.evaluate(() => {
    // Force DOM tiles — Advanced `tileLayer()` may pick WebGL, which has no `.oh-tile-loaded`.
    window.__orihonHighZoomTiles = Orihon.tileLayer(
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      { maxZoom: 19, buffer: 1, renderer: "dom" }
    ).addTo(window.__orihonVisual.map);
    window.__orihonVisual.map.setView([52.52, 13.405], 19);
  });
  await page.waitForFunction(() => {
    const mapRect = document.querySelector("#map")?.getBoundingClientRect();
    if (!mapRect) return false;
    const tileRects = [...document.querySelectorAll(".oh-tile-loaded")].map((tile) =>
      tile.getBoundingClientRect()
    );
    if (!tileRects.length) return false;
    const right = Math.max(...tileRects.map((rect) => rect.right));
    const bottom = Math.max(...tileRects.map((rect) => rect.bottom));
    return right >= mapRect.right - 1 && bottom >= mapRect.bottom - 1;
  });

  const geometry = await page.evaluate(() => {
    const mapRect = document.querySelector("#map").getBoundingClientRect();
    const tileRects = [...document.querySelectorAll(".oh-tile-loaded")].map((tile) => {
      const rect = tile.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
    const transforms = [
      ...document.querySelectorAll(".oh-tile, .oh-marker")
    ].map((element) => element.style.transform);
    return {
      map: { left: mapRect.left, top: mapRect.top, right: mapRect.right, bottom: mapRect.bottom },
      tiles: {
        left: Math.min(...tileRects.map((rect) => rect.left)),
        top: Math.min(...tileRects.map((rect) => rect.top)),
        right: Math.max(...tileRects.map((rect) => rect.right)),
        bottom: Math.max(...tileRects.map((rect) => rect.bottom))
      },
      transforms,
      paneTransforms: [...document.querySelectorAll(".oh-pane")].map((pane) => pane.style.transform),
      viewBox: document.querySelector(".oh-svg-layer")?.getAttribute("viewBox")
    };
  });

  expect(geometry.tiles.left).toBeLessThanOrEqual(geometry.map.left);
  expect(geometry.tiles.top).toBeLessThanOrEqual(geometry.map.top);
  expect(geometry.tiles.right).toBeGreaterThanOrEqual(geometry.map.right);
  expect(geometry.tiles.bottom).toBeGreaterThanOrEqual(geometry.map.bottom);
  expect(geometry.paneTransforms.every((value) => value === "")).toBe(true);
  expect(geometry.viewBox).toBe(
    `0 0 ${Math.round(geometry.map.right - geometry.map.left)} ${Math.round(geometry.map.bottom - geometry.map.top)}`
  );
  for (const transform of geometry.transforms) {
    const values = transform.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];
    expect(values.every((value) => Number.isFinite(value) && Math.abs(value) < 10_000)).toBe(true);
  }
});

test("wheel zoom keeps the pointer geography stable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "Desktop wheel zoom; mobile projects use touch gestures");
  await loadVisualMap(page);
  const viewport = page.viewportSize();
  const anchor = { x: 0.72 * viewport.width, y: 0.31 * viewport.height };
  const before = await page.evaluate((point) => window.__orihonVisual.map.containerPointToLatLng(point), anchor);
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(180);
  const after = await page.evaluate((point) => window.__orihonVisual.map.containerPointToLatLng(point), anchor);

  expect(Math.abs(after.lat - before.lat)).toBeLessThan(1e-9);
  expect(Math.abs(after.lng - before.lng)).toBeLessThan(1e-9);
});

test("opens mountable chart popup and destroys chart on close", async ({ page }) => {
  await loadVisualMap(page);

  await page.evaluate(() => {
    window.__chartPopup = { destroyed: 0, opened: false };
    const chartData = {
      labels: ["Mon", "Tue", "Wed", "Thu", "Fri"],
      datasets: [{ data: [18, 42, 31, 56, 47] }]
    };
    const layer = Orihon.marker([52.52, 13.405])
      .bindPopup(() => ({
        mount(container) {
          const canvas = document.createElement("canvas");
          canvas.className = "e2e-popup-chart";
          canvas.width = 240;
          canvas.height = 100;
          container.append(canvas);
          const drawing = canvas.getContext("2d");
          const values = chartData.datasets[0].data;
          const maximum = Math.max(1, ...values);
          drawing.clearRect(0, 0, canvas.width, canvas.height);
          values.forEach((value, index) => {
            const width = 28;
            const x = 20 + index * 40;
            const height = Math.max(3, (value / maximum) * 70);
            drawing.fillStyle = index % 2 ? "#0f766e" : "#e11d48";
            drawing.fillRect(x, 88 - height, width, height);
          });
          return () => {
            window.__chartPopup.destroyed += 1;
          };
        }
      }), {
        autoPan: false,
        closeOnClick: false,
        className: "analytics-popup"
      })
      .addTo(window.__orihonVisual.map);

    layer.openPopup();
    window.__chartPopup.opened = layer.isPopupOpen();
    window.__chartMarker = layer;
  });

  await expect(page.locator(".oh-popup canvas.e2e-popup-chart")).toBeVisible();
  expect(await page.evaluate(() => window.__chartPopup.opened)).toBe(true);

  await page.evaluate(() => window.__chartMarker.closePopup());
  await expect(page.locator(".oh-popup")).toHaveCount(0);
  expect(await page.evaluate(() => window.__chartPopup.destroyed)).toBe(1);
});

