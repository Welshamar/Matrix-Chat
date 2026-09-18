import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

function base64Of(dataUrl: string): string {
  return dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
}

function mimeOf(dataUrl: string): string {
  const match = /^data:([^;]+);/.exec(dataUrl);
  return match ? match[1] : "application/octet-stream";
}

// A plain <a download> on a data: URL is unreliable inside an Android
// WebView (it silently no-ops on a lot of devices/OS versions) even though
// it works fine in a real browser — so the native build writes through
// Capacitor's Filesystem plugin instead. Directory.Documents is the public
// Documents folder on Android (unlike the app-private default), so a file
// manager or another app can actually find it afterwards.
export async function saveDataUrlFile(dataUrl: string, filename: string): Promise<{ ok: boolean; message: string }> {
  if (Capacitor.isNativePlatform()) {
    try {
      await Filesystem.writeFile({
        path: filename,
        data: base64Of(dataUrl),
        directory: Directory.Documents,
        recursive: true,
      });
      return { ok: true, message: `Saved "${filename}" to Documents.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Couldn't save the file." };
    }
  }

  try {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { ok: true, message: `Downloading "${filename}"...` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Couldn't download the file." };
  }
}

// Separate from saveDataUrlFile: this hands the file off to another app
// (Messages, Gmail, another chat app, etc.) via the native share sheet,
// rather than persisting it to Documents. Written to Cache first since
// it's only needed for the length of the share sheet interaction — the OS
// reclaims cache storage on its own.
export async function shareDataUrlFile(dataUrl: string, filename: string): Promise<{ ok: boolean; message: string }> {
  if (Capacitor.isNativePlatform()) {
    try {
      const written = await Filesystem.writeFile({
        path: filename,
        data: base64Of(dataUrl),
        directory: Directory.Cache,
        recursive: true,
      });
      await Share.share({ title: filename, url: written.uri });
      return { ok: true, message: "" };
    } catch (err) {
      // A user backing out of the share sheet also rejects this promise —
      // that's a cancel, not a real failure, so don't show an error for it.
      const message = err instanceof Error ? err.message : "";
      if (/cancel/i.test(message)) return { ok: true, message: "" };
      return { ok: false, message: message || "Couldn't share the file." };
    }
  }

  // Web Share API (mobile browsers only — no desktop Chrome support as of
  // writing). Falls back to a plain download so the action still does
  // something useful everywhere.
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const file = new File([blob], filename, { type: mimeOf(dataUrl) });
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return { ok: true, message: "" };
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { ok: true, message: "" };
  }
  return saveDataUrlFile(dataUrl, filename);
}
