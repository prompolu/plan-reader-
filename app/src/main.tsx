import React from "react";
import ReactDOM from "react-dom/client";
// hash routes work from local files (desktop app) and any static host (iPhone web app)
import { HashRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import App from "./App";
import { ToastProvider } from "./components/ui";
import { AuthProvider } from "./hooks/auth";
import { getLang, useLang } from "./i18n";
import { desktop } from "./components/ProjectFile";
import { LicenseGate } from "./components/Activation";
import { LicenseProvider } from "./license/license";
import "@fontsource-variable/manrope";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => count < 2 && !(err && typeof err === "object" && "status" in err && [401, 403, 404].includes((err as { status: number }).status)),
      refetchOnWindowFocus: false,
    },
  },
});

// installable web app (iPhone): keep working offline. The desktop app ships its files.
if (import.meta.env.PROD && "serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("offline support unavailable", e));
  });
}
// ask the browser not to clear the projects stored on this device when space runs low
navigator.storage?.persist?.().catch(() => undefined);

document.documentElement.lang = getLang();

/** The desktop menu follows the app's language (also on the activation screen). */
function DesktopMenuLanguage() {
  const lang = useLang();
  React.useEffect(() => {
    desktop()?.setLanguage?.(lang);
  }, [lang]);
  return null;
}

/**
 * Re-renders everything in the chosen language. Data from the app's storage
 * layer (labels, messages, history) is reloaded, because it is translated as
 * it is read.
 */
function LangRoot() {
  const lang = useLang();
  const qc = useQueryClient();
  const first = React.useRef(lang);
  React.useEffect(() => {
    if (lang !== first.current) {
      first.current = lang;
      void qc.resetQueries();
    }
  }, [lang, qc]);
  return <App key={lang} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <DesktopMenuLanguage />
        <LicenseProvider>
          {/* nothing opens (projects, interrupted processing) until this device is activated */}
          <LicenseGate>
            <AuthProvider>
              <ToastProvider>
                <LangRoot />
              </ToastProvider>
            </AuthProvider>
          </LicenseGate>
        </LicenseProvider>
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
