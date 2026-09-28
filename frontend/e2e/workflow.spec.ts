import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const PDF = fileURLToPath(new URL("./fixtures/residential_plans.pdf", import.meta.url));

/**
 * The core workflow against the real backend: open the app (no sign-in),
 * upload a PDF drawing set through the UI, let the pipeline process it,
 * resolve a dimension conflict, verify the opening and export the schedule.
 */
test("upload a PDF, review an opening and export the schedule", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  // opens straight into a fresh private workspace
  await page.goto("/");
  await expect(page.getByText("No projects yet")).toBeVisible();

  await page.locator(".dock-add").click();
  await page.getByLabel("Project name").fill("E2E Residence");
  await page.getByRole("button", { name: "Create and upload plans" }).click();
  await expect(page).toHaveURL(/\/upload$/);

  await page.getByTestId("file-input").setInputFiles(PDF);
  await expect(page.getByText("residential_plans.pdf")).toBeVisible();
  await page.getByRole("button", { name: "Upload and analyse" }).click();
  await expect(page.getByText("Extraction complete")).toBeVisible({ timeout: 120_000 });

  // extraction workspace: W-03's height disagrees between schedule and elevations
  await page.getByText("Open the extraction workspace").click();
  const w03 = page.locator(".otable tbody tr", { hasText: "W-03" }).first();
  await expect(w03).toContainText("Conflict");
  await w03.click();
  const details = page.locator(".details");
  await expect(details.locator(".meas-conflict")).toContainText("Window Schedule");
  await details.locator(".meas-conflict .cand", { hasText: "Window Schedule" }).getByRole("button", { name: "Use this" }).click();
  await expect(details.locator(".meas-conflict")).toHaveCount(0);
  await details.getByRole("button", { name: "Verify" }).click();
  await expect(details.getByText("Verified").first()).toBeVisible();

  // the history records the user's decisions
  await details.getByRole("button", { name: "History" }).click();
  await expect(details.locator(".history")).toContainText(/conflict|resolved/i);

  // the schedule and the exported PDF use the reviewed value
  await page.getByRole("link", { name: /Measurements/ }).click();
  const row = page.locator(".sched-table tbody tr", { hasText: "W-03" }).first();
  await expect(row).toContainText("1200 mm");
  await expect(row).toContainText("Verified");

  await page.getByRole("button", { name: /Download PDF/ }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download summary PDF/ }).click()]);
  const path = await download.path();
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(5_000);

  expect(errors).toEqual([]);
});

test("uploaded files are not publicly reachable", async ({ page, browser }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Try the demo project/ }).click();
  await expect(page.getByText("Extraction complete")).toBeVisible({ timeout: 120_000 });
  const pid = page.url().match(/\/p\/([^/]+)\//)![1];

  // page images are served through signed links only
  const pages = await (await page.request.get(`/api/projects/${pid}/pages`)).json();
  const url: string = pages[0].image_url;
  expect(url).toMatch(/^\/api\/files\/[^/]+\.[^/]+$/);
  expect((await page.request.get(url)).status()).toBe(200);
  expect((await page.request.get(url.slice(0, -4) + "AAAA")).status()).toBeGreaterThanOrEqual(400);

  // another browser (another workspace) can see neither the project nor its files,
  // even with a valid signed link
  const other = await browser.newContext();
  const stranger = await other.newPage();
  await stranger.goto("/");
  await expect(stranger.getByText("No projects yet")).toBeVisible();
  expect((await stranger.request.get(`/api/projects/${pid}/pages`)).status()).toBe(404);
  expect((await stranger.request.get(url)).status()).toBeGreaterThanOrEqual(400);
  await other.close();
});
