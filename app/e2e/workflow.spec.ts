import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const PDF = fileURLToPath(new URL("./fixtures/residential_plans.pdf", import.meta.url));
const SCAN = fileURLToPath(new URL("../benchmark/raster/demo_p4.png", import.meta.url));

/** Every request the page makes must stay inside the app: nothing is uploaded anywhere. */
function watchNetwork(page: Page, base: string) {
  const outside: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(base) && !u.startsWith("blob:") && !u.startsWith("data:")) outside.push(`${r.method()} ${u}`);
  });
  return outside;
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return errors;
}

/**
 * The core workflow, entirely on the device: create a project, add a PDF
 * drawing set, let the engine process it, resolve a dimension conflict,
 * verify the opening, export the schedule, save the project to a file and
 * open it again.
 */
test("process a drawing set on the device, review, export and save a project file", async ({ page, baseURL }) => {
  const errors = watchErrors(page);
  const outside = watchNetwork(page, baseURL!);

  await page.goto("/");
  await expect(page.getByText("No projects yet")).toBeVisible();

  await page.locator(".dock-add").click();
  await page.getByLabel("Project name").fill("E2E Residence");
  await page.getByRole("button", { name: "Create and upload plans" }).click();
  await expect(page).toHaveURL(/\/upload$/);

  await page.getByTestId("file-input").setInputFiles(PDF);
  await expect(page.getByText("residential_plans.pdf")).toBeVisible();
  await page.getByRole("button", { name: "Upload and analyse" }).click();
  await expect(page.getByText("Extraction complete")).toBeVisible({ timeout: 180_000 });

  // extraction workspace: W-03's height disagrees between schedule and elevations
  await page.getByText("Open the extraction workspace").click();
  await expect(page.locator(".viewer-img")).toBeVisible();
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
  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download summary PDF/ }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/_measurement_schedule_summary\.pdf$/);
  const pdfBytes = await readFile((await pdf.path())!);
  expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdfBytes.length).toBeGreaterThan(5_000);

  // save the project to a file, delete it, and open the file again
  await page.goto("/#/projects");
  const [saved] = await Promise.all([page.waitForEvent("download"), page.getByTitle("Save project file").first().click()]);
  expect(saved.suggestedFilename()).toBe("E2E Residence.planmeasure");
  const projectFile = (await saved.path())!;
  expect((await readFile(projectFile)).subarray(0, 2).toString()).toBe("PK");

  page.once("dialog", (d) => d.accept());
  await page.getByTitle("Delete project").first().click();
  await expect(page.getByText("No projects yet.")).toBeVisible();

  await page.locator('input[type=file][accept*=".planmeasure"]').first().setInputFiles({ name: "E2E Residence.planmeasure", mimeType: "application/zip", buffer: await readFile(projectFile) });
  await expect(page).toHaveURL(/\/extraction$/);
  // the reviewed value and the verification came back with the file
  const again = page.locator(".otable tbody tr", { hasText: "W-03" }).first();
  await expect(again).toContainText("1200");
  await expect(again).toContainText("Verified");

  expect(outside).toEqual([]);
  expect(errors).toEqual([]);
});

test("reads a scanned drawing with on-device OCR", async ({ page, baseURL }) => {
  const errors = watchErrors(page);
  const outside = watchNetwork(page, baseURL!);
  await page.goto("/");
  await page.locator(".dock-add").click();
  await page.getByLabel("Project name").fill("Scan");
  await page.getByRole("button", { name: "Create and upload plans" }).click();
  await page.getByTestId("file-input").setInputFiles(SCAN);
  await page.getByRole("button", { name: "Upload and analyse" }).click();
  await expect(page.getByText("Extraction complete")).toBeVisible({ timeout: 200_000 });
  await page.getByText("Open the extraction workspace").click();
  // OCR found tagged openings on the scan
  await expect(page.locator(".otable tbody tr", { hasText: /W-0\d|D-0\d/ }).first()).toBeVisible();
  expect(outside).toEqual([]);
  expect(errors).toEqual([]);
});

test("projects are private to the browser profile they were created in", async ({ page, browser }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Try the demo project/ }).click();
  await expect(page.getByText("Extraction complete")).toBeVisible({ timeout: 180_000 });

  const other = await browser.newContext();
  const stranger = await other.newPage();
  await stranger.goto("/");
  await expect(stranger.getByText("No projects yet")).toBeVisible();
  await other.close();
});
