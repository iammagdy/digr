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
