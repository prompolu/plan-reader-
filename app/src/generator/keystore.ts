/**
 * The vendor's secret key on this device, encrypted with a PIN (PBKDF2 +
 * AES-GCM). It never leaves the device: no server, nothing sent anywhere.
 */
const KEY = "planmeasure.generator.key.v1";
const ITERATIONS = 310_000;

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export const hasStoredKey = () => {
  try {
    return !!localStorage.getItem(KEY);
  } catch {
    return false;
  }
};

export async function storeKey(privateKey: string, pin: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(pin, salt), new TextEncoder().encode(privateKey));
  localStorage.setItem(KEY, JSON.stringify({ salt: b64(salt), iv: b64(iv), data: b64(data) }));
}

/** The secret key, or undefined when the PIN is wrong. */
export async function unlockKey(pin: string): Promise<string | undefined> {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "") as { salt: string; iv: string; data: string };
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) }, await aesKey(pin, unb64(s.salt)), unb64(s.data));
    return new TextDecoder().decode(plain);
  } catch {
    return undefined;
  }
}

export const forgetKey = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
};

// ---- licences issued on this device ------------------------------------------

export interface IssuedLicense {
  /** Day of issue, YYYY-MM-DD. */
  readonly date: string;
  readonly client: string;
  readonly device: string;
  /** Last day of use, YYYY-MM-DD; absent: permanent. */
  readonly expiresOn?: string;
  readonly number: number;
  readonly code: string;
}

const HISTORY = "planmeasure.generator.history.v1";

export function readHistory(): IssuedLicense[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY) ?? "[]") as IssuedLicense[];
  } catch {
    return [];
  }
}

export function addToHistory(l: IssuedLicense): IssuedLicense[] {
  const all = [l, ...readHistory()];
  try {
    localStorage.setItem(HISTORY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
  return all;
}

/** Licence number from the minute of issue (YYMMDDhhmm): unique across the vendor's computer and phone. */
export function licenseNumber(d = new Date()): number {
  const p = (n: number) => String(n).padStart(2, "0");
  return Number(`${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`);
}
