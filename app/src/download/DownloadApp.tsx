import { Apple, Download, MessageCircle, Monitor, Ruler, Smartphone } from "lucide-react";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { VENDOR_NAME, whatsappToVendor } from "../license/contact";
import { t, useLang } from "../i18n";

/**
 * The public download page for clients: the latest installers (fixed links on
 * the vendor's download storage, replaced by each new version), the iPhone
 * app, and how to get an activation code.
 */
const DOWNLOADS = String(import.meta.env.VITE_DOWNLOADS_URL ?? "").replace(/\/+$/, "");
export const FILES = { windows: "PlanMeasure-Windows.exe", windows7: "PlanMeasure-Windows7.exe", mac: "PlanMeasure-Mac.dmg" } as const;

function Option({ href, icon, title, detail, testId }: { href: string; icon: React.ReactNode; title: string; detail: string; testId: string }) {
  return (
    <a className="dl-option" href={href} data-testid={testId}>
      {icon}
      <span>
        <b>{title}</b>
        <small>{detail}</small>
      </span>
      <Download size={16} className="dl-arrow" />
    </a>
  );
}

export function DownloadApp() {
  useLang();
  return (
    <div className="activation download" data-testid="download-page">
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
        <h1>{t("Download PlanMeasure AI")}</h1>
        <p className="muted">{t("Doors, windows and openings — measured from your drawings, with evidence for every value.")}</p>

        {DOWNLOADS ? (
          <div className="dl-list">
            <Option href={`${DOWNLOADS}/${FILES.windows}`} testId="download-windows" icon={<Monitor size={22} />} title="Windows" detail={t("Windows 10 and 11")} />
            <Option href={`${DOWNLOADS}/${FILES.mac}`} testId="download-mac" icon={<Apple size={22} />} title="Mac" detail={t("Apple silicon and Intel · macOS 10.13 or later")} />
            <Option href={`${DOWNLOADS}/${FILES.windows7}`} testId="download-windows7" icon={<Monitor size={22} />} title="Windows 7" detail={t("Windows 7, 8 and 8.1 · 64-bit and 32-bit")} />
          </div>
        ) : (
          <div className="banner banner-warn">{t("The installers are not published from this version.")}</div>
        )}
        <a className="dl-option" href="./" data-testid="phone-link">
          <Smartphone size={22} />
          <span>
            <b>iPhone / iPad</b>
            <small>{t("Open it in Safari, then Share → Add to Home Screen.")}</small>
          </span>
        </a>

        <div className="gen-section">
          <b>{t("First launch")}</b>
          <p className="small muted">{t("Windows: if SmartScreen warns you, click “More info” → “Run anyway”.")}</p>
          <p className="small muted">{t("Mac: open the file and drag PlanMeasure AI to Applications. The first time, right-click the app → “Open”.")}</p>
          <p className="small muted">{t("The app then shows this device's code: send it to {vendor} to receive your activation code.", { vendor: VENDOR_NAME })}</p>
          <div className="row gap">
            <a className="btn" href={whatsappToVendor(t("Hello, I would like an activation code for PlanMeasure AI."))} target="_blank" rel="noreferrer" data-testid="download-whatsapp">
              <MessageCircle size={14} /> {t("Contact {vendor} on WhatsApp", { vendor: VENDOR_NAME })}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
