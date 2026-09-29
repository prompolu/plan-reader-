/**
 * The only bridge between the app page and the desktop shell: project files
 * opened from Finder / Explorer or the File menu are handed to the page, and
 * the computer's identity for the licence's device code.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("planmeasureDesktop", {
  platform: process.platform,
  /** Receive project files the user opened outside the app. Call once the page can handle them. */
  onOpenFile(callback) {
    ipcRenderer.removeAllListeners("pm:open-file");
    ipcRenderer.on("pm:open-file", (_e, file) => callback({ name: String(file.name), data: file.data }));
    ipcRenderer.send("pm:ready");
  },
  chooseProjectFile() {
    ipcRenderer.send("pm:choose-file");
  },
  /** What identifies this computer; the licence's device code is derived from it. */
  deviceIdentity() {
    return ipcRenderer.invoke("pm:device-identity");
  },
  /** Menu labels follow the language chosen in the app. */
  setLanguage(lang) {
    ipcRenderer.send("pm:language", String(lang));
  },
});
