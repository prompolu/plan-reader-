import { defineConfig } from "@playwright/test";

// The API (which also serves the built SPA) must be running, e.g.
//   cd backend && uvicorn planmeasure.main:app --port 8000
// after `npm run build`. Override the target with PM_E2E_BASE_URL.
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PM_E2E_BASE_URL ?? "http://localhost:8000",
    viewport: { width: 1500, height: 920 },
    trace: "retain-on-failure",
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
});
