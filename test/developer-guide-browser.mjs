import { chromium } from "@playwright/test";

const base = process.env.ORIHON_DOCS_URL ?? "http://127.0.0.1:4179";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
let errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

async function checkFunction(name) {
  errors = [];
  await page.goto(`${base}/examples/developer-guide/functions/${name}/`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-playground-status]").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const status = document.querySelector("[data-playground-status]")?.textContent ?? "";
    return status.startsWith("Готово") || status.startsWith("Ошибка");
  }, null, { timeout: 30_000 });

  const status = await page.locator("[data-playground-status]").textContent();
  const frame = page.frameLocator("[data-playground-frame]");
  const badge = await frame.locator("#badge").textContent();
  const canvasCount = await frame.locator("#map canvas").count();
  return { name, status, badge, canvasCount, errors: [...errors] };
}

try {
  if (process.env.ORIHON_DOCS_ALL === "1") {
    const response = await page.request.get(`${base}/examples/developer-guide/manifest.json`);
    const manifest = await response.json();
    const results = [];
    for (const item of manifest.functions) results.push(await checkFunction(item.name));
    const failed = results.filter((result) => !result.status?.startsWith("Готово") || !result.canvasCount || result.errors.length);
    console.log(JSON.stringify({ checked: results.length, failed }, null, 2));
    if (failed.length) throw new Error(`${failed.length} developer playgrounds failed`);
  } else {
    const result = await checkFunction("heatLayer");
    const options = await page.locator(".option-detail tbody tr").count();
    console.log(JSON.stringify({ ...result, options }, null, 2));
    if (!result.status?.startsWith("Готово")) throw new Error(result.status ?? "Playground did not report completion");
    if (options < 20) throw new Error(`Only ${options} HeatLayerOptions fields were rendered`);
    if (!result.canvasCount) throw new Error("Live map did not render a canvas");
    if (result.errors.length) throw new Error(`Browser errors: ${result.errors.join(" | ")}`);
  }
} finally {
  await browser.close();
}
