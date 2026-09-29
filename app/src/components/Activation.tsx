import { useState, type ReactNode } from "react";
import { Copy, KeyRound, MessageCircle, Ruler } from "lucide-react";
import type { LicenseCheck } from "../license/codes";
import { VENDOR_NAME, whatsappToVendor } from "../license/contact";
import { RENEW_NOTICE_DAYS, useLicense, type LicenseControl } from "../license/license";
import { locale, t, tp, useLang } from "../i18n";
import { LanguageSwitch } from "./LanguageSwitch";

/** An expiry date is a UTC calendar day: show that day wherever the device is. */
export const fmtLicenseDate = (d: Date) => d.toLocaleDateString(locale(), { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });

function problemText(p: LicenseCheck | "CLOCK" | undefined): string {
  if (!p) return "";
  if (p === "CLOCK") return t("The date on this device is behind. Set the correct date and time, then open the app again.");
  if (p.ok) return "";
  if (p.reason === "EXPIRED")
    return `${p.expiresOn ? t("This licence expired on {date}.", { date: fmtLicenseDate(p.expiresOn) }) : t("This licence has expired.")} ${t("Ask {vendor} for a new code.", { vendor: VENDOR_NAME })}`;
  return p.reason === "FORMAT" ? t("The code is incomplete or was not copied correctly: paste all of it.") : t("This code is not valid for this device.");
}

/**
 * Shown until this device has a valid activation code: the device code to
 * send to the vendor, and the field for the code received back. Also opened
 * from Settings to enter a new code (renewal), with a Cancel button.
 */
export function ActivationScreen({ control, onCancel }: { control: LicenseControl; onCancel?: () => void }) {
  useLang();
  const { state } = control;
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<LicenseCheck | undefined>();
  if (state.status === "loading") return null;
  const deviceCode = state.deviceCode;
  const problem = result && !result.ok ? result : state.status === "needed" ? state.problem : undefined;
  const whatsapp = whatsappToVendor(t("Hello, here is my device code for PlanMeasure AI: {code}", { code: deviceCode }));

  return (
    <div className="activation" data-testid="activation">
      <div className="card strong activation-card">
        <div className="row between gap wrap">
          <div className="activation-brand">
            <span className="logo">
              <Ruler size={15} />
            </span>
            <span>
              PlanMeasure <b>AI</b>
            </span>
          </div>
          <LanguageSwitch compact />
        </div>
        <h1>{t("Activate PlanMeasure AI")}</h1>
        <p className="muted">{t("Send this device's code to {vendor}. You will receive an activation code: paste it below. It only works on this device.", { vendor: VENDOR_NAME })}</p>

        <div className="activation-field">
          <span className="activation-label">{t("This device's code")}</span>
          <div className="device-code" data-testid="device-code">
            {deviceCode}
          </div>
        </div>
        <div className="row gap wrap">
          <button
            type="button"
            className="btn"
            data-testid="copy-device-code"
            onClick={() => void navigator.clipboard?.writeText(deviceCode).then(() => setCopied(true), () => setCopied(false))}
          >
            <Copy size={14} /> {copied ? t("Copied") : t("Copy")}
          </button>
          <a className="btn" href={whatsapp} data-testid="whatsapp-vendor" target="_blank" rel="noreferrer">
            <MessageCircle size={14} /> {t("Send by WhatsApp")}
          </a>
        </div>

        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!code.trim()) return;
            setBusy(true);
            try {
              setResult(await control.activate(code));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            {t("Activation code")}
            <textarea
              data-testid="activation-code"
              className="code-input"
              rows={4}
              value={code}
              placeholder={t("Paste the code you received here")}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => {
                setCode(e.target.value);
                setResult(undefined);
              }}
            />
          </label>
          {problem && (
            <div className="banner banner-warn" data-testid="activation-error" role="alert">
              {problemText(problem)}
            </div>
          )}
          <div className="row gap activation-actions">
            {onCancel && (
              <button type="button" className="btn" onClick={onCancel}>
                {t("Cancel")}
              </button>
            )}
            <button type="submit" className="btn btn-primary" data-testid="activate" disabled={busy || !code.trim()}>
              <KeyRound size={14} /> {t("Activate")}
            </button>
          </div>
        </form>
        <p className="small muted">{t("The code is checked on this device, without an internet connection. Projects already on this device are kept.")}</p>
      </div>
    </div>
  );
}

/** The app opens once this device is activated (or when licensing is off in this build). */
export function LicenseGate({ children }: { children: ReactNode }) {
  const control = useLicense();
  useLang();
  const { state } = control;
  if (state.status === "loading") return null;
  if (state.status === "needed") return <ActivationScreen control={control} />;
  return (
    <>
      {children}
      {control.renewing && (
        <div className="activation-overlay">
          <ActivationScreen control={control} onCancel={() => control.setRenewing(false)} />
        </div>
      )}
    </>
  );
}

/** A yearly licence near its end: a reminder with the way to enter the new code. */
export function LicenseBanner() {
  const { state, setRenewing } = useLicense();
  if (state.status !== "active" || state.daysLeft === undefined || state.daysLeft > RENEW_NOTICE_DAYS) return null;
  const n = state.daysLeft;
  return (
    <div className="banner banner-warn license-banner row gap wrap" data-testid="license-banner">
      <span className="grow">
        {n === 0 ? t("Your licence ends today.") : tp(n, "{n} day of licence left.", "{n} days of licence left.")} {t("Ask {vendor} for a new code.", { vendor: VENDOR_NAME })}
      </span>
      <button className="btn btn-sm" onClick={() => setRenewing(true)}>
        {t("Enter a new code")}
      </button>
    </div>
  );
}
