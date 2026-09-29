import { defineConfig } from "@playwright/test";

// Runs the built app (`npm run build` first) from a local static server, like
// the iPhone web app. Override the target with PM_E2E_BASE_URL.
export default defineConfig({
  testDir: "./e2e",
  timeout: 240_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"]],
  webServer: process.env.PM_E2E_BASE_URL
    ? undefined
    : { command: "npx vite preview --port 4173 --strictPort", url: "http://localhost:4173", reuseExistingServer: true, timeout: 60_000 },
  use: {
    baseURL: process.env.PM_E2E_BASE_URL ?? "http://localhost:4173",
    viewport: { width: 1500, height: 920 },
    acceptDownloads: true,
    trace: "retain-on-failure",
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
});
