/**
 * electron-builder hook: ad-hoc sign the macOS app.
 *
 * Without a Developer ID certificate electron-builder leaves the app unsigned,
 * and Apple silicon Macs refuse to start unsigned code ("app is damaged").
 * An ad-hoc signature lets it run; the first launch still needs right-click ->
 * Open because the app is not notarised. The per-architecture copies made for
 * the universal build are left alone: only the merged app is signed.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (/-temp$/.test(context.appOutDir)) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${app}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
};
