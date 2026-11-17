import { isPersonalMailDomain, isPlausibleEmail, type FoundEmail } from "./policy";
import { isRoleMailbox } from "../agentMission/people";

/**
 * Strict, fail-closed helpers of the e-mail lookup and the chain's TREG directory calls.
 * catalog figure, unverified, owner-accepted under D-0027
 */

export const TREG_MAX_STATEMENT = "catalog figure, unverified, owner-accepted under D-0027";
export const TREG_EMAIL_LOOKUP = { endpointId: "tomba.companies.emails.list", method: "GET" as const, allowedParamKeys: ["domain", "limit"] as string[], limit: 10, reservedUsd: 0.0089, headerCeilingUsd: 0.02 } as const;
export const TREG_DIRECTORY = { endpointId: "icypeas.companies.search", method: "POST" as const, pageSize: 10, reservedUsd: 0.00576, headerCeilingUsd: 0.05 } as const;

export const ORIGIN_CHARSET_RE = /^[A-Za-z0-9:/._~%?&=#@+,;!$*()'-]{1,200}$/;
export const HOST_RE = /^[a-z0-9.-]{1,100}$/;
export const stripControl = (raw: string): string => raw.replace(/[\u0000-\u001f\u007f]/g, "");
export const utf8Bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export const escapedBytes = (s: string): number => Buffer.byteLength(JSON.stringify(s)) - 2;

function parseInstantKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mon = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const hh = parseInt(m[4], 10);
  const mm = parseInt(m[5], 10);
  const ss = parseInt(m[6], 10);
  const fraction6 = (m[7] || "").padEnd(6, "0");
  const tz = m[8];
  let offsetMinutes = 0;
  if (tz !== "Z") {
    const sign = tz[0] === "-" ? -1 : 1;
    const clean = tz.slice(1).replace(":", "");
    const offH = parseInt(clean.slice(0, 2), 10);
    const offM = clean.length >= 4 ? parseInt(clean.slice(2, 4), 10) : 0;
    offsetMinutes = sign * (offH * 60 + offM);
  }
  const thatMs = Date.UTC(y, mon - 1, d, hh, mm, ss) - offsetMinutes * 60000;
  const that = new Date(thatMs).toISOString().slice(0, 19);
  return that + "." + fraction6;
}

export function sameInstant(a: unknown, b: unknown): boolean {
  const keyA = parseInstantKey(a);
  const keyB = parseInstantKey(b);
  return keyA !== null && keyA === keyB;
}

export const COMPANY_MAILBOX_ORDER: ReadonlyArray<string> = ["info", "contact", "contactus", "sales", "office", "hello", "enquiries", "inquiries", "admin", "support", "customercare", "customerservice", "marketing", "service", "mail", "reception"];

export type TregAnswerKind = "empty" | "non_empty" | "unparsable";

export function tombaAnswerKind(body: unknown): TregAnswerKind {
  if (!body || typeof body !== "object") return "unparsable";
  const b = body as any;
  if (!Array.isArray(b?.data?.emails)) return "unparsable";
  if (b.data.emails.length >= 1) return "non_empty";
  if (b.data.emails.length === 0 && typeof b?.meta?.total === "number" && b.meta.total === 0) return "empty";
  return "unparsable";
}

export function readTombaMailbox(body: unknown, requestedDomain: string): FoundEmail | null {
  const want = requestedDomain.trim().toLowerCase().replace(/^www\./, "");
  if (!body || typeof body !== "object") return null;
  const b = body as any;
  const metaDomain = typeof b?.meta?.params?.domain === "string" ? b.meta.params.domain.trim().toLowerCase().replace(/^www\./, "") : null;
  if (metaDomain !== want) return null;
  const org = b?.data?.organization;
  if (!org || typeof org !== "object") return null;
  if (org.disposable === true || org.webmail === true || org.accept_all === true) return null;
  if (!Array.isArray(b?.data?.emails)) return null;

  const rawEmails: any[] = b.data.emails;
  const candidates = rawEmails.filter((e) => e && typeof e === "object" && typeof e.email === "string").slice(0, 50);

  return null;
}
