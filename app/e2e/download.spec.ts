import { expect, test } from "@playwright/test";

test("download page for clients: fixed links to the latest installers, the iPhone app and the vendor", async ({ page }) => {
  await page.goto("/download.html");
  await expect(page.getByRole("heading", { name: "Download PlanMeasure AI" })).toBeVisible();
  // the test build points at a placeholder download address (.env.e2e)
  await expect(page.getByTestId("download-windows")).toHaveAttribute("href", "https://downloads.example.invalid/PlanMeasure-Windows.exe");
  await expect(page.getByTestId("download-windows7")).toHaveAttribute("href", "https://downloads.example.invalid/PlanMeasure-Windows7.exe");
  await expect(page.getByTestId("download-mac")).toHaveAttribute("href", "https://downloads.example.invalid/PlanMeasure-Mac.dmg");
  await expect(page.getByTestId("phone-link")).toHaveAttribute("href", "./");
  await expect(page.getByTestId("download-whatsapp")).toHaveAttribute("href", /^https:\/\/wa\.me\/212668378538\?text=/);
  // in French too
  await page.getByRole("button", { name: "FR" }).click();
  await expect(page.getByRole("heading", { name: "Télécharger PlanMeasure AI" })).toBeVisible();
  await expect(page.getByTestId("download-windows7")).toContainText("64 bits et 32 bits");
});
