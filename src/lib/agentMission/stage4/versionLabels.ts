import { formatAr } from "../../arabicDigits";
import type { VersionReason } from "./versions";

/**
 * STAGE 4, S2: the customer's words for a file version (client-safe: no server module). Arabic only, Arabic-Indic numerals, no provider, no id, no money.
 * The summary of a version as the versions route returns it; the list itself is read by `versionList.ts` (server only).
 */
export interface VersionSummary { version: number; parent: number | null; reason: VersionReason; createdAt: string; digest: string }

const REASON_AR: Record<VersionReason, string> = { delivery: "التسليم", edit: "تعديل", review_fix: "إصلاح من المراجعة" };
/** «النسخة ١ (التسليم)», «النسخة ٢ (تعديل)». */
export const versionLabelAr = (version: number, reason: VersionReason): string => `النسخة ${formatAr(version)} (${REASON_AR[reason]})`;
/** «مأخوذة من النسخة ١»; the delivery has no parent. */
export const versionParentAr = (parent: number | null): string => (parent === null ? "" : `مأخوذة من النسخة ${formatAr(parent)}`);
export const VERSIONS_HEADING_AR = "نسخ الملف";
export const VERSIONS_NOTE_AR = "النسخة الأولى هي ما سُلّم إليك، ولا تتغير أبدًا.";

/** MONEY PR 7b (2B-2 task 1): «النسخة ١ — الملف الأصلي», «النسخة ٢ — بعد التعديل», «النسخة ٣ — بعد تصحيح المراجعة». */
const TITLE_AR: Record<VersionReason, string> = { delivery: "الملف الأصلي", edit: "بعد التعديل", review_fix: "بعد تصحيح المراجعة" };
export const versionTitleAr = (version: number, reason: VersionReason): string => `النسخة ${formatAr(version)} — ${TITLE_AR[reason]}`;
export const VERSION_DOWNLOAD_BUTTON_AR = "تحميل الملف";
export const VERSION_DOWNLOADING_AR = "جارٍ التحميل…";
/** The button's accessible name: its visible words first, then which version. */
export const versionDownloadLabelAr = (version: number): string => `${VERSION_DOWNLOAD_BUTTON_AR}، النسخة ${formatAr(version)}`;
/** What the customer is told when a version cannot be downloaded: plain Arabic, no code, no path, no provider. */
export const VERSION_DOWNLOAD_ERRORS_AR = {
  not_found: "هذه النسخة غير متاحة للتنزيل.",
  unavailable: "تعذّر تنزيل الملف الآن. حاول بعد قليل.",
  damaged: "تعذّر تجهيز هذه النسخة. تواصل معنا إذا تكرر ذلك.",
  unauthorized: "انتهت جلستك. سجّل الدخول ثم حاول مرة أخرى.",
  network: "تعذّر الاتصال الآن. تحقق من اتصالك وحاول بعد قليل.",
} as const;
