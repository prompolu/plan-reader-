import * as ed from "@noble/ed25519";

/**
 * PlanMeasure activation codes (the same scheme as Debromp's).
 *
 * Each device has a device code, derived from the computer on Mac / Windows
 * and from a random identity kept by the browser on a phone. The vendor signs,
 * with a secret key that never leaves its own devices, a message binding that
 * device code to an expiry date (or none: permanent) and a licence number.
 * The app only holds the public key: it can check a code, never make one. A
 * code copied to another device fails because the device code differs.
 *
 * Codes are signed under a PlanMeasure prefix, so a Debromp code never
 * unlocks PlanMeasure (and the other way round), even with the same key.
 */

/** Day 0 of expiry dates. */
const EPOCH = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;
const VERSION = 1;
/** version (1) + expiry day (2) + licence number (4) + signature (64). */
const CODE_BYTES = 1 + 2 + 4 + 64;

// ---- Crockford base32: case-insensitive, no I / L / O / U ------------------

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Upper case, separators removed, the look-alike letters read as digits. */
const clean = (text: string) =>
  text
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");

function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text: string, length: number): Uint8Array | undefined {
  const out = new Uint8Array(length);
  let bits = 0;
  let value = 0;
  let i = 0;
  for (const c of clean(text)) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) return undefined;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      if (i >= length) return undefined;
      out[i++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return i === length ? out : undefined;
}

const group = (s: string, n: number) => s.match(new RegExp(`.{1,${n}}`, "g"))!.join("-");

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
function unhex(h: string): Uint8Array {
  const s = h.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error("invalid key");
  return Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));
}

// ---- Device codes ------------------------------------------------------------

/** "7K3F-92QX-M4TB": 60 bits of the SHA-256 of what identifies the device. */
export async function deviceCodeFrom(identity: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`planmeasure-device|${identity}`)));
  return group(toBase32(digest.slice(0, 8)).slice(0, 12), 4);
}

/** The device code as typed or pasted: spaces, case and dashes do not matter. */
export function normalizeDeviceCode(input: string): string | undefined {
  const c = clean(input);
  if (c.length !== 12 || [...c].some((x) => !ALPHABET.includes(x))) return undefined;
  return group(c, 4);
}

// ---- Keys --------------------------------------------------------------------

export interface KeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
}

export async function newKeyPair(): Promise<KeyPair> {
  const priv = ed.utils.randomPrivateKey();
  return { privateKey: hex(priv), publicKey: hex(await ed.getPublicKeyAsync(priv)) };
}

/** Throws for anything that is not a 64-character hex secret key. */
export async function publicKeyOf(privateKey: string): Promise<string> {
  return hex(await ed.getPublicKeyAsync(unhex(privateKey)));
}

// ---- Activation codes ----------------------------------------------------------

export interface LicenseTerms {
  /** Last day of use (yearly licence); none: permanent. */
  readonly expiresOn?: Date;
  /** The vendor's own number for this licence, for its records. */
  readonly number: number;
}

const expiryDay = (d?: Date) => (d ? Math.max(1, Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - EPOCH) / DAY)) : 0);
const dayToDate = (n: number) => new Date(EPOCH + n * DAY);

const message = (device: string, day: number, number: number) => new TextEncoder().encode(`PLANMEASURE-${VERSION}|${device}|${day}|${number}`);

export async function createActivationCode(privateKey: string, deviceCode: string, terms: LicenseTerms): Promise<string> {
  const device = normalizeDeviceCode(deviceCode);
  if (!device) throw new Error("invalid device code");
  if (!Number.isInteger(terms.number) || terms.number < 0 || terms.number > 0xffffffff) throw new Error("invalid licence number");
  const day = expiryDay(terms.expiresOn);
  if (day > 0xffff) throw new Error("expiry date too far away");
  const sig = await ed.signAsync(message(device, day, terms.number), unhex(privateKey));
  const bytes = new Uint8Array(CODE_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, VERSION);
  view.setUint16(1, day);
  view.setUint32(3, terms.number);
  bytes.set(sig, 7);
  return group(toBase32(bytes), 6);
}

export interface License {
  readonly deviceCode: string;
  readonly number: number;
  /** Last day of use; absent for a permanent licence. */
  readonly expiresOn?: Date;
}

export type LicenseCheck =
  | { readonly ok: true; readonly license: License; readonly daysLeft?: number }
  | { readonly ok: false; readonly reason: "FORMAT" | "INVALID" | "EXPIRED"; readonly expiresOn?: Date };

/**
 * Checks an activation code for this device, offline. "INVALID" covers a
 * code made for another device, a mistyped code and a forged one alike: the
 * signature does not match.
 */
export async function checkActivationCode(code: string, deviceCode: string, publicKeys: readonly string[], now: Date): Promise<LicenseCheck> {
  const bytes = fromBase32(code, CODE_BYTES);
  const device = normalizeDeviceCode(deviceCode);
  if (!bytes || !device || bytes[0] !== VERSION) return { ok: false, reason: "FORMAT" };
  const view = new DataView(bytes.buffer);
  const day = view.getUint16(1);
  const number = view.getUint32(3);
  const sig = bytes.slice(7);
  const msg = message(device, day, number);
  let valid = false;
  for (const key of publicKeys) {
    try {
      if (await ed.verifyAsync(sig, msg, unhex(key))) {
        valid = true;
        break;
      }
    } catch {
      // malformed key: try the next one
    }
  }
  if (!valid) return { ok: false, reason: "INVALID" };
  if (!day) return { ok: true, license: { deviceCode: device, number } };
  const expiresOn = dayToDate(day);
  // valid through the whole last day (UTC)
  const end = expiresOn.getTime() + DAY;
  if (now.getTime() >= end) return { ok: false, reason: "EXPIRED", expiresOn };
  const daysLeft = Math.floor((end - now.getTime()) / DAY);
  return { ok: true, license: { deviceCode: device, number, expiresOn }, daysLeft };
}
