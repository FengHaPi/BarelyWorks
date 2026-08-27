import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: "line",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  webServer: {
    command: "npx tsx tests/e2e/fixture-server.ts",
    url: "http://127.0.0.1:4328/api/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4328",
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 720 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
