import { defineConfig } from "@playwright/test";

const desktop = { width: 800, height: 500 };

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: "http://127.0.0.1:4389",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node scripts/browser-test-server.mjs",
    url: "http://127.0.0.1:4389/test/fixtures/visual.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium", viewport: desktop } },
    { name: "firefox", use: { browserName: "firefox", viewport: desktop } },
    { name: "webkit", use: { browserName: "webkit", viewport: desktop } },
    {
      name: "mobile-chromium",
      use: { browserName: "chromium", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
    },
    {
      name: "mobile-webkit",
      use: { browserName: "webkit", viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true }
    }
  ]
});
