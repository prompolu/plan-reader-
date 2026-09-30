/**
 * electron-builder settings for the Windows 7 installer: the same app on
 * Electron 22, the last version that runs on Windows 7 / 8 / 8.1 (Electron 23+
 * needs Windows 10). One installer for 64-bit and 32-bit Windows.
 *
 *   npx electron-builder --win -c build/win7.config.cjs
 *
 * Electron 22 no longer receives security updates; the app never loads web
 * content, runs sandboxed and only opens local files, so the risk is low, but
 * machines on Windows 10 / 11 should use the regular installer.
 */
const base = require("../package.json").build;

module.exports = {
  ...base,
  electronVersion: "22.3.27",
  win: { ...base.win, target: [{ target: "nsis", arch: ["x64", "ia32"] }] },
  nsis: { ...base.nsis, artifactName: "PlanMeasure-AI-Setup-${version}-Windows7.${ext}" },
};
