import type { BrowserContext } from "@playwright/test";
import { createActivationCode, deviceCodeFrom } from "../src/license/codes";

/**
 * Test-only key: its public half is in the app only when built with
 * `npm run build:e2e` (the CI browser-test build), never in a published app.
 */
export const TEST_PRIVATE_KEY = "6281973f8d04d1b6562ad4b7f4e4f111cbc200dc365da903c70591845f3b1add";
export const TEST_PUBLIC_KEY = "5e156eee8a584d9283b96dd60953a6bbadf4d5c14e804aea484c011f92e3feca";
/** The browser identity the tests give the app (instead of a random one). */
export const TEST_IDENTITY = "web:e2e-device";

export const DEVICE_KEY = "planmeasure.device.v1";
export const ACTIVATION_KEY = "planmeasure.activation.v1";
export const LAST_SEEN_KEY = "planmeasure.lastSeen.v1";

export const testDeviceCode = () => deviceCodeFrom(TEST_IDENTITY);

export async function activationCodeFor(identity: string, expiresOn?: Date, number = 1): Promise<string> {
  return createActivationCode(TEST_PRIVATE_KEY, await deviceCodeFrom(identity), { number, ...(expiresOn ? { expiresOn } : {}) });
}

/**
 * Before the app's first page load in this browser profile: the test device
 * identity, plus any other stored values (an activation code, a last-seen
 * date). Later reloads keep what the app stored itself.
 */
export async function prepareDevice(context: BrowserContext, extra: Record<string, string> = {}): Promise<void> {
  await context.addInitScript(
    ([id, more]) => {
      if (localStorage.getItem("e2e.prepared")) return;
      localStorage.setItem("e2e.prepared", "1");
      localStorage.setItem("planmeasure.device.v1", id as string);
      for (const [k, v] of Object.entries(more as Record<string, string>)) localStorage.setItem(k, v);
    },
    [TEST_IDENTITY, extra] as const,
  );
}

/** This browser profile starts activated with a permanent test licence. */
export async function activate(context: BrowserContext): Promise<void> {
  await prepareDevice(context, { [ACTIVATION_KEY]: await activationCodeFor(TEST_IDENTITY) });
}
