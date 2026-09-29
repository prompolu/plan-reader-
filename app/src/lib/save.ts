/** Saving files on every platform: desktop app, browser, iPhone. */

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/**
 * Save a file to the user's device: a save dialog in the desktop app, the
 * Downloads folder in a browser, the share sheet ("Save to Files") on iPhone.
 */
export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  if (isIOS() && typeof navigator.canShare === "function") {
    const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return; // the user closed the share sheet
        // otherwise (e.g. no longer allowed after a long export) fall back to a download
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
