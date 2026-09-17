import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

// A plain <a download> on a data: URL is unreliable inside an Android
// WebView (it silently no-ops on a lot of devices/OS versions) even though
// it works fine in a real browser — so the native build writes through
// Capacitor's Filesystem plugin instead, then immediately opens the native
// share sheet on that file. Filesystem's Directory.Documents is app-private
// storage (not the public Downloads folder a file manager would show), so
// without the share step the file would be saved but effectively
// unreachable — the share sheet is what actually lets the person move it
// to Downloads, another app, etc.
export async function saveDataUrlFile(dataUrl: string, filename: string): Promise<{ ok: boolean; message: string }> {
  if (Capacitor.isNativePlatform()) {
    try {
      const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
      const written = await Filesystem.writeFile({
        path: filename,
        data: base64,
        directory: Directory.Documents,
        recursive: true,
      });
      try {
        await Share.share({ title: filename, url: written.uri });
      } catch {
        // Share sheet dismissed/unavailable — the file is still saved, so
        // this isn't a failure, just a smaller confirmation message below.
      }
      return { ok: true, message: `Saved "${filename}".` };
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
