/**
 * Raw first-page capture (ON by default, one code constant turns it off): the first RAW provider page of a job, kept for the owner so the next fixtures come from real calls, not from
 * hand-written rows. The rows the worker stores afterwards are already flattened and gated; the answer's envelope, its cursor and the rows the gate rejected
 * are lost, and that is exactly what a replay needs.
 *
 * Private bucket only (`partials/<jobId>/raw_first_page.json`), never shown to a customer. Emails and phone numbers are masked, long text is cut, and the whole
 * record is size-capped, so it holds the SHAPE and a few real values without personal data. No token, key or header is ever part of the record.
 */

export const RAW_CAPTURE_FLAG = "RAW_FIRST_PAGE_CAPTURE";
/**
 * The capture is ON by default (owner decision: the owner does not change deployment settings). To turn it off, set this constant to false in code. The environment
 * variable `RAW_FIRST_PAGE_CAPTURE=off` also turns it off (never needed); any other value leaves the default.
 */
export const RAW_CAPTURE_ENABLED = true;
/** Largest stored record, in bytes of its JSON text. */
export const RAW_CAPTURE_MAX_BYTES = 120_000;
/** Longest string kept as it came; a longer one is cut. */
export const RAW_CAPTURE_MAX_STRING = 400;
/** Items kept of any list before the size cap tightens it further. */
export const RAW_CAPTURE_MAX_ITEMS = 25;

export function rawCaptureEnabled(env: Record<string, string | undefined> = process.env, enabled: boolean = RAW_CAPTURE_ENABLED): boolean {
  if (!enabled) return false;
  return String(env[RAW_CAPTURE_FLAG] ?? "").trim().toLowerCase() !== "off";
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 7 or more digits with the usual separators, possibly after «+»: a phone number; plain long ids (no separators) are kept
const PHONE = /(?<![\w])\+?\d[\d\s().-]{6,}\d(?![\w])/g;

/** An email as «a***@domain.tld»; a phone as «[رقم محجوب]»-style mask that keeps only the last two digits. */
export function maskText(text: string): string {
  return String(text)
    .replace(EMAIL, (m) => `${m[0]}***@${m.split("@")[1]}`)
    .replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, "");
      // a long run of digits with no separator is an id (tweet, video), not a phone
      if (digits.length === m.length && digits.length >= 12) return m;
      return digits.length >= 7 && /[\s().+-]/.test(m) ? `***${digits.slice(-2)}` : m;
    });
}

function maskValue(value: unknown, depth: number, itemCap: number): unknown {
  if (typeof value === "string") {
    const masked = maskText(value);
    return masked.length > RAW_CAPTURE_MAX_STRING ? `${masked.slice(0, RAW_CAPTURE_MAX_STRING)}…` : masked;
  }
  if (typeof value !== "object" || value === null) return value;
  if (depth > 12) return "[عمق]";
  if (Array.isArray(value)) return value.slice(0, itemCap).map((v) => maskValue(v, depth + 1, itemCap));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskValue(v, depth + 1, itemCap);
  return out;
}

export interface RawFirstPage {
  jobId: string;
  endpointId: string;
  httpStatus: number;
  page: number;
  capturedAt: string;
  truncated: boolean;
  /** The provider's answer exactly as it came (after masking and the size cap). */
  body: unknown;
}

/** The record for one call: masked, and cut (lists first, then deeper) until it fits `RAW_CAPTURE_MAX_BYTES`. */
export function buildRawFirstPage(input: { jobId: string; endpointId: string; httpStatus: number; page: number; body: unknown; now?: Date }): RawFirstPage {
  let cap = RAW_CAPTURE_MAX_ITEMS;
  let body = maskValue(input.body, 0, cap);
  let truncated = JSON.stringify(input.body ?? null).length > JSON.stringify(body ?? null).length;
  const wrap = (b: unknown): RawFirstPage => ({ jobId: input.jobId, endpointId: input.endpointId, httpStatus: input.httpStatus, page: input.page, capturedAt: (input.now ?? new Date()).toISOString(), truncated, body: b });
  while (JSON.stringify(wrap(body)).length > RAW_CAPTURE_MAX_BYTES && cap > 1) {
    cap = Math.max(1, Math.floor(cap / 2));
    body = maskValue(input.body, 0, cap);
    truncated = true;
  }
  return wrap(body);
}

/** What `executeTregCall` hands over after a call. */
export interface RawCallRecord {
  endpointId: string;
  httpStatus: number;
  page: number;
  body: unknown;
}
export type RawCapture = (record: RawCallRecord) => Promise<void>;

/** A capture that keeps ONLY the first call of the job (a later call, a retry, a second source: ignored). */
export function createFirstPageCapture(store: { upload: (path: string, body: any, options?: any) => Promise<any> }, jobId: string): RawCapture {
  let taken = false;
  return async (record) => {
    if (taken) return;
    taken = true;
    const page = buildRawFirstPage({ jobId, endpointId: record.endpointId, httpStatus: record.httpStatus, page: record.page, body: record.body });
    await store.upload(`${jobId}/raw_first_page.json`, Buffer.from(JSON.stringify(page), "utf-8"), { contentType: "application/json", upsert: true });
  };
}
