import { describe, expect, it } from "vitest";
import { checkActivationCode, createActivationCode, deviceCodeFrom, newKeyPair, normalizeDeviceCode, publicKeyOf } from "./codes";
import { LICENSE_KEYS } from "./keys";

describe("activation codes bound to a device", () => {
  it("a code signed for one device only works on that device", async () => {
    const keys = await newKeyPair();
    expect(await publicKeyOf(keys.privateKey)).toBe(keys.publicKey);
    const mine = await deviceCodeFrom("machine-A");
    const other = await deviceCodeFrom("machine-B");
    expect(mine).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(mine).not.toBe(other);
    expect(await deviceCodeFrom("machine-A")).toBe(mine);
    const code = await createActivationCode(keys.privateKey, mine, { number: 7 });
    expect(code).toMatch(/^([0-9A-Z]{6}-){18}[0-9A-Z]{6}$/);
    const now = new Date("2026-09-28");
    expect(await checkActivationCode(code, mine, [keys.publicKey], now)).toMatchObject({ ok: true, license: { number: 7 } });
    expect(await checkActivationCode(code, other, [keys.publicKey], now)).toMatchObject({ ok: false, reason: "INVALID" });
    // pasted from a message: case, spaces, dashes and line breaks do not matter
    expect(await checkActivationCode(code.toLowerCase().replace(/-/g, " \n"), mine.toLowerCase(), [keys.publicKey], now)).toMatchObject({ ok: true });
  });

  it("another key cannot make a valid code", async () => {
    const vendor = await newKeyPair();
    const forger = await newKeyPair();
    const device = await deviceCodeFrom("machine-A");
    const forged = await createActivationCode(forger.privateKey, device, { number: 1 });
    expect(await checkActivationCode(forged, device, [vendor.publicKey], new Date())).toMatchObject({ ok: false, reason: "INVALID" });
    // any of several keys may sign; a malformed key in the list is skipped
    expect(await checkActivationCode(forged, device, ["not-a-key", vendor.publicKey, forger.publicKey], new Date())).toMatchObject({ ok: true });
  });

  it("a changed licence number or expiry date breaks the signature", async () => {
    const keys = await newKeyPair();
    const device = await deviceCodeFrom("machine-A");
    const code = await createActivationCode(keys.privateKey, device, { number: 5, expiresOn: new Date("2027-01-31") });
    // the first characters hold the version, the expiry day and the number
    const chars = code.split("");
    chars[3] = chars[3] === "Z" ? "Y" : "Z";
    expect(await checkActivationCode(chars.join(""), device, [keys.publicKey], new Date("2027-01-01"))).toMatchObject({ ok: false });
  });

  it("yearly licence: valid through its last day, then expired", async () => {
    const keys = await newKeyPair();
    const device = await deviceCodeFrom("machine-A");
    const code = await createActivationCode(keys.privateKey, device, { number: 2, expiresOn: new Date("2027-09-28") });
    expect(await checkActivationCode(code, device, [keys.publicKey], new Date("2027-08-29T12:00:00Z"))).toMatchObject({ ok: true, daysLeft: 30 });
    const last = await checkActivationCode(code, device, [keys.publicKey], new Date("2027-09-28T20:00:00Z"));
    expect(last).toMatchObject({ ok: true, daysLeft: 0 });
    expect(last.ok && last.license.expiresOn?.toISOString()).toBe("2027-09-28T00:00:00.000Z");
    expect(await checkActivationCode(code, device, [keys.publicKey], new Date("2027-09-29T01:00:00Z"))).toMatchObject({ ok: false, reason: "EXPIRED" });
  });

  it("permanent licence: no end date", async () => {
    const keys = await newKeyPair();
    const device = await deviceCodeFrom("machine-A");
    const code = await createActivationCode(keys.privateKey, device, { number: 3 });
    const r = await checkActivationCode(code, device, [keys.publicKey], new Date("2060-01-01"));
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && (r.license.expiresOn ?? r.daysLeft)).toBeUndefined();
  });

  it("malformed device or activation codes are refused", async () => {
    expect(normalizeDeviceCode("7k3f 92qx m4tb")).toBe("7K3F-92QX-M4TB");
    expect(normalizeDeviceCode("7K3F-92QX-M4T")).toBeUndefined();
    expect(normalizeDeviceCode("7K3F-92QX-M4TU")).toBeUndefined();
    expect(await checkActivationCode("ABC", "7K3F-92QX-M4TB", [], new Date())).toMatchObject({ ok: false, reason: "FORMAT" });
    await expect(publicKeyOf("1234")).rejects.toThrow();
    await expect(createActivationCode((await newKeyPair()).privateKey, "123", { number: 1 })).rejects.toThrow();
  });

  it("a Debromp code does not unlock PlanMeasure, even when signed with the same key", async () => {
    // Debromp's test key (its public half is only in Debromp's CI test builds)
    const debrompTestKey = "00e6bfebc15954a2fa615cb5785cd00a57c15da4ff6916313e6730a41947d8ce";
    const publicKey = await publicKeyOf(debrompTestKey);
    expect(publicKey).toBe("f59e1602e6bf8f880e5f812b94a9a24f7ed75f376d050fb2f6c9e79bcd851295");
    // made by Debromp's generator for device 7K3F-92QX-M4TB, licence 1, permanent
    const debrompCode =
      "040000-00000M-JE0RP7-VEN3V4-92G1T2-RARZRC-9SJKXZ-HPWAXY-WGYJ9E-KY6ZSS-YHHBDP-Q6V4KE-M4TM2D-2VSSKN-ADXAV7-TVRDXC-BA76WY-4XQZFM-FBB50C";
    expect(await checkActivationCode(debrompCode, "7K3F-92QX-M4TB", [publicKey], new Date())).toMatchObject({ ok: false, reason: "INVALID" });
    const planmeasureCode = await createActivationCode(debrompTestKey, "7K3F-92QX-M4TB", { number: 1 });
    expect(planmeasureCode).not.toBe(debrompCode);
    expect(await checkActivationCode(planmeasureCode, "7K3F-92QX-M4TB", [publicKey], new Date())).toMatchObject({ ok: true });
    // each app shows its own device code for the same computer
    expect(await deviceCodeFrom("machine-A")).not.toBe("D2E8-S25E-X3VX");
  });

  it("the published key list holds the vendor's key and, outside test builds, no test key", () => {
    expect(LICENSE_KEYS).toContain("3ff022edf370eb0fd27cc1e567d8d49c716cdaef187a01f0ab70b14a1d8b7b58");
    if (import.meta.env.VITE_PLANMEASURE_TEST !== "1") expect(LICENSE_KEYS).toHaveLength(1);
  });
});
