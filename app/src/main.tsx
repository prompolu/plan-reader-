import React from "react";
import ReactDOM from "react-dom/client";
// hash routes work from local files (desktop app) and any static host (iPhone web app)
import { HashRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ToastProvider } from "./components/ui";
import { AuthProvider } from "./hooks/auth";
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
