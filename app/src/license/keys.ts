/**
 * Public keys that sign PlanMeasure activation codes. A public key can only
 * check a code, never make one: the secret key stays on the vendor's own
 * devices (code generator, generator.html).
 *
 * Empty = licensing off: the app runs without activation.
 */
const VENDOR_KEYS: readonly string[] = [
  // Prompolu, key 1 (2026-09) - the same key as Debromp's, so the same secret
  // key makes the codes of both apps (each app only accepts its own codes).
  "3ff022edf370eb0fd27cc1e567d8d49c716cdaef187a01f0ab70b14a1d8b7b58",
];

/**
 * Automated tests only. Present in a build made with `--mode e2e`
 * (VITE_PLANMEASURE_TEST=1, the CI browser-test build); left out of every
 * other build, so its private key in e2e/ can never activate a real
 * installation. CI checks that published builds do not contain it.
 */
const TEST_KEYS: readonly string[] = import.meta.env.VITE_PLANMEASURE_TEST === "1" ? ["5e156eee8a584d9283b96dd60953a6bbadf4d5c14e804aea484c011f92e3feca"] : [];

export const LICENSE_KEYS: readonly string[] = [...VENDOR_KEYS, ...TEST_KEYS];
