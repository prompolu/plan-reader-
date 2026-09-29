import { expect, test } from "@playwright/test";
import { checkActivationCode } from "../src/license/codes";
import { ACTIVATION_KEY, LAST_SEEN_KEY, TEST_IDENTITY, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY, activationCodeFor, prepareDevice, testDeviceCode } from "./license-helper";

const DAY = 86_400_000;

test("without a code the activation screen is shown; wrong, foreign and expired codes are refused; the right code opens the app", async ({ page, context }) => {
  await prepareDevice(context);
  await page.goto("/");
  await expect(page.getByTestId("activation")).toBeVisible();
  const device = await testDeviceCode();
  await expect(page.getByTestId("device-code")).toHaveText(device);
  // nothing of the app is open behind it
  await expect(page.locator(".dock")).toHaveCount(0);
  // WhatsApp opens the chat with the vendor, device code already written
  await expect(page.getByTestId("whatsapp-vendor")).toHaveAttribute("href", new RegExp(`^https://wa\\.me/212668378538\\?text=.*${device}$`));

  // the screen follows the language switch
  await page.getByRole("button", { name: "FR" }).click();
  await expect(page.getByRole("heading", { name: "Activer PlanMeasure AI" })).toBeVisible();
  await page.getByRole("button", { name: "EN" }).click();
  await expect(page.getByRole("heading", { name: "Activate PlanMeasure AI" })).toBeVisible();

  const input = page.getByTestId("activation-code");
  await input.fill("ABC-123");
  await page.getByTestId("activate").click();
  await expect(page.getByTestId("activation-error")).toContainText("not copied correctly");

  await input.fill(await activationCodeFor("web:another-computer"));
  await page.getByTestId("activate").click();
  await expect(page.getByTestId("activation-error")).toContainText("not valid for this device");

  await input.fill(await activationCodeFor(TEST_IDENTITY, new Date("2026-01-15")));
  await page.getByTestId("activate").click();
  await expect(page.getByTestId("activation-error")).toContainText("expired on January 15, 2026");

  // pasted from WhatsApp: lower case, spaces, line breaks
  const code = await activationCodeFor(TEST_IDENTITY);
  await input.fill(code.toLowerCase().replace(/-/g, " \n"));
  await page.getByTestId("activate").click();
  await expect(page.getByText("No projects yet")).toBeVisible();
  await expect(page.locator(".dock")).toBeVisible();

  // checked again (offline) at every start
  await page.reload();
  await expect(page.getByText("No projects yet")).toBeVisible();
  await page.getByRole("link", { name: /Settings/ }).click();
  const info = page.getByTestId("license-info");
  await expect(info).toContainText("Permanent licence");
  await expect(info).toContainText(device);
  await expect(page.getByTestId("license-banner")).toHaveCount(0);
});

test("yearly licence: a reminder 30 days before the end, and the new code entered from it", async ({ page, context }) => {
  const soon = new Date(Date.now() + 10 * DAY);
  await prepareDevice(context, { [ACTIVATION_KEY]: await activationCodeFor(TEST_IDENTITY, soon) });
  await page.goto("/");
  await expect(page.getByText("No projects yet")).toBeVisible();
  const banner = page.getByTestId("license-banner");
  await expect(banner).toContainText(/(9|10) days of licence left/);

  await page.getByRole("link", { name: /Settings/ }).click();
  await expect(page.getByTestId("license-info")).toContainText("Licence valid until");

  // renewal: the activation screen opens over the app and can be cancelled
  await banner.getByRole("button", { name: "Enter a new code" }).click();
  await expect(page.getByTestId("activation")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("activation")).toHaveCount(0);

  await page.getByTestId("license-new-code").click();
  await page.getByTestId("activation-code").fill(await activationCodeFor(TEST_IDENTITY, new Date(Date.now() + 400 * DAY), 2));
  await page.getByTestId("activate").click();
  await expect(page.getByTestId("activation")).toHaveCount(0);
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("license-info")).toContainText("Licence valid until");
  await expect(page.getByTestId("license-info")).toContainText("2");
});

test("a clock turned back to stretch a licence is refused", async ({ page, context }) => {
  await prepareDevice(context, {
    [ACTIVATION_KEY]: await activationCodeFor(TEST_IDENTITY),
    [LAST_SEEN_KEY]: String(Date.now() + 30 * DAY),
  });
  await page.goto("/");
  await expect(page.getByTestId("activation-error")).toContainText("date on this device is behind");
  await expect(page.locator(".dock")).toHaveCount(0);
});

test("generator: a key created on the device, a PIN, a code valid for the client's device only", async ({ page }) => {
  await page.goto("/generator.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByTestId("create-key").click();
  const secret = (await page.getByTestId("secret-key").textContent())!.trim();
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId("continue")).toBeDisabled();
  await page.getByTestId("saved").check();
  await page.getByTestId("continue").click();
  await page.getByTestId("pin").fill("2468");
  await page.getByTestId("pin-again").fill("2468");
  await page.getByTestId("pin-ok").click();
  // a brand-new key is not in the app: codes made with it would be refused
  await expect(page.getByTestId("key-not-in-app")).toBeVisible();

  const device = "7K3F-92QX-M4TB";
  await page.getByTestId("client").fill("Carter Joinery");
  await page.getByTestId("device").fill("7k3f 92qx m4t");
  await expect(page.getByTestId("generate")).toBeDisabled();
  await page.getByTestId("device").fill("7k3f 92qx m4tb");
  await page.getByTestId("kind-yearly").check();
  await page.getByTestId("until").fill("2031-12-31");
  await page.getByTestId("generate").click();
  const code = (await page.getByTestId("activation-result").textContent())!.trim();
  await page.locator("details.gen-section").last().locator("summary").click();
  const publicKey = (await page.getByTestId("public-key").textContent())!.trim();
  await expect(page.getByTestId("history")).toContainText("Carter Joinery");
  await expect(page.getByTestId("whatsapp-client")).toHaveAttribute("href", /^https:\/\/wa\.me\/\?text=Hello%20Carter%20Joinery/);

  const now = new Date("2027-01-01");
  const ok = await checkActivationCode(code, device, [publicKey], now);
  expect(ok).toMatchObject({ ok: true });
  expect(ok.ok && ok.license.expiresOn?.toISOString()).toMatch(/^2031-12-31/);
  expect(await checkActivationCode(code, "AAAA-BBBB-CCCC", [publicKey], now)).toMatchObject({ ok: false });

  // locked: the PIN is needed again; a wrong one is refused
  await page.getByTestId("lock").click();
  await page.getByTestId("unlock-pin").fill("0000");
  await page.getByTestId("unlock").click();
  await expect(page.getByTestId("pin-error")).toBeVisible();
  await page.getByTestId("unlock-pin").fill("2468");
  await page.getByTestId("unlock").click();
  await expect(page.getByTestId("history")).toContainText("Carter Joinery");
});

test("generator to app: a code made with an imported key activates the client's device", async ({ page, context }) => {
  // the vendor imports its key on another device (the test key, known to this test build)
  await page.goto("/generator.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByTestId("import-key").click();
  await page.getByTestId("secret-input").fill("not a key");
  await page.getByTestId("import-ok").click();
  await expect(page.getByText("This is not a secret key")).toBeVisible();
  await page.getByTestId("secret-input").fill(TEST_PRIVATE_KEY.toUpperCase());
  await page.getByTestId("import-ok").click();
  await page.getByTestId("pin").fill("1357");
  await page.getByTestId("pin-again").fill("1357");
  await page.getByTestId("pin-ok").click();
  await expect(page.getByTestId("public-key")).toHaveText(TEST_PUBLIC_KEY);
  await expect(page.getByTestId("key-not-in-app")).toHaveCount(0);

  await page.getByTestId("client").fill("Client test");
  await page.getByTestId("device").fill(await testDeviceCode());
  await page.getByTestId("generate").click();
  const code = (await page.getByTestId("activation-result").textContent())!.trim();

  // the client's device
  const client = await context.browser()!.newContext();
  await prepareDevice(client);
  const app = await client.newPage();
  await app.goto("/");
  await app.getByTestId("activation-code").fill(code);
  await app.getByTestId("activate").click();
  await expect(app.getByText("No projects yet")).toBeVisible();
  await client.close();
});
