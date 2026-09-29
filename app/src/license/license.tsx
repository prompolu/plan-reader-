import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { checkActivationCode, deviceCodeFrom, type License, type LicenseCheck } from "./codes";
import { LICENSE_KEYS } from "./keys";

/**
 * The licence of this device: an activation code made by the vendor for this
 * device's code. Kept on the device and checked at every start, offline.
 */

export const ACTIVATION = "planmeasure.activation.v1";
/** Browser (phone) identity: random, created once, kept with the app's data. */
export const DEVICE = "planmeasure.device.v1";
/** Latest date seen, against a clock turned back to stretch a yearly licence. */
export const LAST_SEEN = "planmeasure.lastSeen.v1";
/** A clock may drift or change time zone: two days of tolerance. */
const CLOCK_TOLERANCE = 2 * 86_400_000;
/** Days before the end of a yearly licence when the renewal reminder appears. */
export const RENEW_NOTICE_DAYS = 30;

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};

type Bridge = { deviceIdentity?: () => Promise<string> };

async function deviceIdentity(): Promise<string> {
  // Mac / Windows app: the computer's own identifier
  const desktop = (window as unknown as { planmeasureDesktop?: Bridge }).planmeasureDesktop;
  if (desktop?.deviceIdentity) return desktop.deviceIdentity();
  // phone / browser: an identity created once and kept by this browser
  let id = read(DEVICE);
  if (!id) {
    id = `web:${crypto.randomUUID()}`;
    write(DEVICE, id);
  }
  return id;
}

export type LicenseState =
  | { readonly status: "loading" }
  /** No public key in this build: licensing not switched on. */
  | { readonly status: "off"; readonly deviceCode: string }
  | { readonly status: "active"; readonly deviceCode: string; readonly license: License; readonly daysLeft?: number }
  | { readonly status: "needed"; readonly deviceCode: string; readonly problem?: LicenseCheck | "CLOCK" };

export interface LicenseControl {
  readonly state: LicenseState;
  /** Checks and, when valid, keeps a new activation code. */
  activate(code: string): Promise<LicenseCheck>;
  /** The activation screen is open to enter a new code (renewal). */
  readonly renewing: boolean;
  setRenewing(on: boolean): void;
}

function clockTurnedBack(now: Date): boolean {
  const last = Number(read(LAST_SEEN) ?? 0);
  if (last && now.getTime() < last - CLOCK_TOLERANCE) return true;
  if (now.getTime() > last) write(LAST_SEEN, String(now.getTime()));
  return false;
}

async function evaluate(code: string | null): Promise<LicenseState> {
  const deviceCode = await deviceCodeFrom(await deviceIdentity());
  if (!LICENSE_KEYS.length) return { status: "off", deviceCode };
  const now = new Date();
  if (clockTurnedBack(now)) return { status: "needed", deviceCode, problem: "CLOCK" };
  if (!code) return { status: "needed", deviceCode };
  const check = await checkActivationCode(code, deviceCode, LICENSE_KEYS, now);
  return check.ok
    ? { status: "active", deviceCode, license: check.license, ...(check.daysLeft !== undefined ? { daysLeft: check.daysLeft } : {}) }
    : { status: "needed", deviceCode, problem: check };
}

const Ctx = createContext<LicenseControl | null>(null);

export function LicenseProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LicenseState>({ status: "loading" });
  const [renewing, setRenewing] = useState(false);

  useEffect(() => {
    let live = true;
    evaluate(read(ACTIVATION))
      .then((s) => live && setState(s))
      .catch((e) => {
        console.error(e);
        if (live) setState({ status: "needed", deviceCode: "" });
      });
    return () => {
      live = false;
    };
  }, []);

  const activate = useCallback(async (code: string) => {
    const deviceCode = await deviceCodeFrom(await deviceIdentity());
    const check = await checkActivationCode(code, deviceCode, LICENSE_KEYS, new Date());
    if (check.ok) {
      write(ACTIVATION, code.trim());
      setState(await evaluate(code.trim()));
      setRenewing(false);
    }
    return check;
  }, []);

  return <Ctx.Provider value={{ state, activate, renewing, setRenewing }}>{children}</Ctx.Provider>;
}

export function useLicense(): LicenseControl {
  const c = useContext(Ctx);
  if (!c) throw new Error("useLicense outside LicenseProvider");
  return c;
}
