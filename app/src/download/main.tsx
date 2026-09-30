import React from "react";
import ReactDOM from "react-dom/client";
import { getLang } from "../i18n";
import { DownloadApp } from "./DownloadApp";
import "@fontsource-variable/manrope";
import "../styles.css";

document.documentElement.lang = getLang();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DownloadApp />
  </React.StrictMode>,
);
