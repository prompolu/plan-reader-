import { Languages } from "lucide-react";
import { LANGUAGES, setLang, t, useLang, type Lang } from "../i18n";

/** English / Français / Español. The choice is remembered on this device. */
export function LanguageSwitch({ compact }: { compact?: boolean }) {
  const lang = useLang();
  return (
    <div className="row gap lang-switch">
      {!compact && <Languages size={15} aria-hidden />}
      <div className="seg" role="group" aria-label={t("Language")}>
        {LANGUAGES.map((l) => (
          <button key={l.code} className={l.code === lang ? "active" : ""} onClick={() => setLang(l.code as Lang)} lang={l.code} aria-pressed={l.code === lang}>
            {compact ? l.code.toUpperCase() : l.name}
          </button>
        ))}
      </div>
    </div>
  );
}
