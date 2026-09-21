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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read the file."));
    reader.onload = () => resolve(base64Of(reader.result as string));
    reader.readAsDataURL(blob);
  });
}

// Multiple of 3 so each slice's base64 has no padding and the pieces concatenate
// cleanly. Written piece by piece so a large video never becomes one giant
// base64 string in memory (which crashes an Android WebView well below 100 MB).
const NATIVE_WRITE_STEP = 3 * 1024 * 1024;

// `source` is a data: or blob: URL (both are fetchable), so the same path
// serves small inline files and large decrypted attachments.
async function writeNative(source: string, filename: string, directory: Directory): Promise<string> {
  let blob: Blob;
  try {
    blob = await (await fetch(source)).blob();
  } catch {
    // fetch() on a data URL can be refused in some WebViews -- small files
    // still fall back to writing the base64 directly.
    const written = await Filesystem.writeFile({ path: filename, data: base64Of(source), directory, recursive: true });
    return written.uri;
  }

  if (blob.size <= NATIVE_WRITE_STEP) {
    const written = await Filesystem.writeFile({ path: filename, data: await blobToBase64(blob), directory, recursive: true });
    return written.uri;
  }
  let uri = "";
  for (let offset = 0; offset < blob.size; offset += NATIVE_WRITE_STEP) {
    const data = await blobToBase64(blob.slice(offset, offset + NATIVE_WRITE_STEP));
    if (offset === 0) {
      uri = (await Filesystem.writeFile({ path: filename, data, directory, recursive: true })).uri;
    } else {
      await Filesystem.appendFile({ path: filename, data, directory });
    }
  }
  return uri;
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
      await writeNative(dataUrl, filename, Directory.Documents);
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
      const uri = await writeNative(dataUrl, filename, Directory.Cache);
      await Share.share({ title: filename, url: uri });
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
