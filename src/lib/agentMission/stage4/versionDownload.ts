import { formatAr } from "../../arabicDigits";
import { fileNameFromDisposition } from "../../downloadName";
import { VERSION_DOWNLOAD_ERRORS_AR } from "./versionLabels";

/**
 * MONEY PR 7b, 2B-2 task 1: THE CLICK ON «تحميل الملف» (client-safe: no server module). One request to the customer's own file route with the version number, then the bytes go to `save` under the name the server wrote in its header.
 * `fetch`, the bearer header and `save` are injected, so the loading, success and failure paths are tested without a browser. Every failure is a controlled Arabic sentence; nothing is saved unless the answer was the file.
 */
export const versionFileUrl = (missionId: string, version: number): string => `/api/missions/${encodeURIComponent(missionId)}/file?name=result.xlsx&version=${version}&stream=1`;

export type VersionDownloadResult = { ok: true } | { ok: false; message: string };

const messageOfStatus = (status: number): string =>
  status === 404 ? VERSION_DOWNLOAD_ERRORS_AR.not_found : status === 401 ? VERSION_DOWNLOAD_ERRORS_AR.unauthorized : status === 500 ? VERSION_DOWNLOAD_ERRORS_AR.damaged : VERSION_DOWNLOAD_ERRORS_AR.unavailable;

export async function downloadVersionFile(input: { missionId: string; version: number; fetchFn: typeof fetch; headers: () => Promise<Record<string, string>>; save: (blob: Blob, name: string) => void }): Promise<VersionDownloadResult> {
  if (!Number.isInteger(input.version) || input.version < 1 || input.version > 9999) return { ok: false, message: VERSION_DOWNLOAD_ERRORS_AR.not_found };
  try {
    const res = await input.fetchFn(versionFileUrl(input.missionId, input.version), { cache: "no-store", headers: await input.headers() });
    if (!res.ok) return { ok: false, message: messageOfStatus(res.status) };
    const blob = await res.blob();
    input.save(blob, fileNameFromDisposition(res.headers.get("Content-Disposition")) || `النسخة ${formatAr(input.version)}.xlsx`);
    return { ok: true };
  } catch {
    return { ok: false, message: VERSION_DOWNLOAD_ERRORS_AR.network };
  }
}
