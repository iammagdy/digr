/**
 * A FILE THE ADMIN UPLOADS to attach to a customer's e-mail (the results sheet, a report): what is accepted, checked by its name AND its first bytes.
 * The platform accepts a request body of about 4.5 MB, so one upload is at most 4 MB.
 */
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

const KINDS: Record<string, { labelAr: string; magic: (b: Buffer) => boolean }> = {
  // xlsx and docx are zip archives
  xlsx: { labelAr: "Excel", magic: (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  docx: { labelAr: "Word", magic: (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  pdf: { labelAr: "PDF", magic: (b) => b.length > 4 && b.subarray(0, 5).toString("latin1") === "%PDF-" },
  // a text file: no NUL byte in it
  csv: { labelAr: "CSV", magic: (b) => b.length > 0 && !b.subarray(0, 65536).includes(0) },
};
export const UPLOAD_ACCEPT = ".xlsx,.csv,.pdf,.docx";

/** A safe file name: the base name only, no control characters or path separators, at most 120 characters, the extension kept. */
export function safeAttachmentName(raw: string): string {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 120 - ext.length) + ext;
}

export function checkUploadedAttachment(name: string, bytes: Buffer): { ok: true; filename: string } | { ok: false; errorAr: string } {
  const filename = safeAttachmentName(name);
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const kind = KINDS[ext];
  if (!filename || !kind) return { ok: false, errorAr: "نوع الملف غير مسموح؛ المسموح: Excel ‏(xlsx) أو CSV أو PDF أو Word ‏(docx)." };
  if (bytes.length === 0) return { ok: false, errorAr: "الملف المرفوع فارغ." };
  if (bytes.length > UPLOAD_MAX_BYTES) return { ok: false, errorAr: "الملف أكبر من ٤ ميجابايت." };
  if (!kind.magic(bytes)) return { ok: false, errorAr: `محتوى الملف لا يطابق نوعه (${kind.labelAr}).` };
  return { ok: true, filename };
}
