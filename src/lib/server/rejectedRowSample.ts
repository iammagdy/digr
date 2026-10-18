/**
 * Diagnosis sample of rows the relevance gate rejected. It is kept in the job's partials storage so a
 * wrong exclusion can be investigated later. It never reaches the customer, never changes what is
 * delivered or charged, and holds at most REJECTED_SAMPLE_LIMIT masked rows per job.
 */
export const REJECTED_SAMPLE_LIMIT = 10;

export type RejectedReasonCode =
  | "out_of_region"
  | "industry_mismatch"
  | "no_text"
  | "topic_not_in_text"
  | "other_mismatch";

export interface RejectedRowSampleEntry {
  reasonCode: RejectedReasonCode;
  reasonAr: string;
  fields: Record<string, string>;
}

/** Stable code for the gate's Arabic reason, so rejections can be counted by cause. */
export function rejectionReasonCode(reasonAr: string): RejectedReasonCode {
  const reason = String(reasonAr || "");
  if (/النطاق الجغرافي/.test(reason)) return "out_of_region";
  if (/لا يتضمن السجل نصا|لا يتضمن السجل نصاً/.test(reason)) return "no_text";
  if (/لا يتضمن نص السجل كلمات/.test(reason)) return "topic_not_in_text";
  if (/ليس شركة|مجالاً مختلفاً|غير مرتبط|غير مطابق|وصف النشاط|النشاط/.test(reason)) return "industry_mismatch";
  return "other_mismatch";
}

/** Emails, phone numbers and links never appear in the sample in readable form. */
export function maskSensitive(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (email) => `${email[0]}***@***`)
    .replace(/https?:\/\/([^\s/]+)[^\s]*/gi, (_url, host: string) => `${host}/***`)
    .replace(/\+?\d[\d\s().-]{6,}\d/g, (phone) => `***${phone.replace(/\D/g, "").slice(-2)}`);
}

function clip(value: unknown, length: number): string {
  return maskSensitive(String(value ?? "").replace(/\s+/g, " ").trim()).slice(0, length);
}

/** Only fields that explain a rejection are kept; personal handles are cut to two characters. */
const DIAGNOSTIC_FIELDS: Array<{ keys: string[]; label: string; length: number; handle?: boolean }> = [
  { keys: ["id", "company_id", "source_id", "video_id", "post_id", "comment_id"], label: "id", length: 40 },
  { keys: ["company_name", "name", "title", "video_title"], label: "name", length: 60 },
  { keys: ["industry", "activity", "sector", "category"], label: "industry", length: 60 },
  { keys: ["country", "country_code", "region", "region_code"], label: "country", length: 30 },
  { keys: ["city", "location", "address"], label: "place", length: 60 },
  { keys: ["text", "comment_text", "caption", "video_caption", "description"], label: "text", length: 80 },
  { keys: ["author_name", "username", "channel_name"], label: "author", length: 30, handle: true },
];

export function maskRejectedRow(row: Record<string, any>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const spec of DIAGNOSTIC_FIELDS) {
    const key = spec.keys.find((candidate) => row?.[candidate] !== undefined && row?.[candidate] !== null && String(row[candidate]).trim());
    if (!key) continue;
    const clipped = clip(row[key], spec.length);
    if (!clipped) continue;
    fields[spec.label] = spec.handle ? `${clipped.slice(0, 2)}***` : clipped;
  }
  return fields;
}

export function buildRejectedSample(
  rejectedRows: Array<Record<string, any>>,
  limit = REJECTED_SAMPLE_LIMIT,
): RejectedRowSampleEntry[] {
  return rejectedRows.slice(0, Math.max(0, limit)).map((row) => {
    const reasonAr = String(row._relevance_reason || "غير مطابق");
    return { reasonCode: rejectionReasonCode(reasonAr), reasonAr: clip(reasonAr, 160), fields: maskRejectedRow(row) };
  });
}

/** Adds this chunk's rejections to what the job already stored, never exceeding the per-job cap. */
export function mergeRejectedSample(
  existing: RejectedRowSampleEntry[] | null | undefined,
  incoming: RejectedRowSampleEntry[],
  limit = REJECTED_SAMPLE_LIMIT,
): RejectedRowSampleEntry[] {
  const kept = Array.isArray(existing) ? existing.slice(0, limit) : [];
  return [...kept, ...incoming].slice(0, limit);
}
