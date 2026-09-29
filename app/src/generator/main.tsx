import React from "react";
import ReactDOM from "react-dom/client";
import { getLang } from "../i18n";
import { GeneratorApp } from "./GeneratorApp";
import "@fontsource-variable/manrope";
import "../styles.css";

// installed on an iPhone home screen: keep working offline, like the app
if (import.meta.env.PROD && "serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("offline support unavailable", e));
  });
}

document.documentElement.lang = getLang();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <GeneratorApp />
  </React.StrictMode>,
);
