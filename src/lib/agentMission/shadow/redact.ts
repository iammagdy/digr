/**
 * PHASE 7: REDACTION FOR THE ADMIN SHADOW VIEW. Everything the shadow view shows or returns passes through here: a request typed or stored by a customer can carry a name, an e-mail, a phone number or a link to a private account, and nothing the view
 * prints may carry an internal credential. Pure, deterministic, no I/O. Over-redaction is the safe direction: a counted number («٥٠ شركة») is kept (only 7+ digit runs and phone shapes go), but anything shaped like a secret goes.
 */
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹";
const digitsOf = (s: string): string => s.replace(/[٠-٩۰-۹]/g, (d) => String(AR_DIGITS.indexOf(d) % 10));

export const REDACTED = { email: "[بريد]", phone: "[رقم]", link: "[رابط]", handle: "@…", secret: "[سر]", id: "[معرّف]" } as const;

/** Credential shapes: provider keys («sk-…», «key_…»), JWTs, bearer tokens, `name=value` pairs of a secret-like name, long unbroken tokens. */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g,
  /\b(?:sk|pk|rk|key|tok|secret|svc)[-_][A-Za-z0-9_-]{12,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[-_ ]?key|secret|token|password|passwd|authorization|service[-_ ]?role)\s*[:=]\s*\S{4,}/gi,
  // long random-looking tokens: a lowercase hex digest, or a mixed-case token with digits (a snake_case code name such as «historical_source_below_verification» is NOT a secret)
  /\b[0-9a-f]{32,}\b/g,
  /\b(?=(?:[A-Za-z_-]*\d){3})(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{32,}\b/g,
];

export function redactText(input: unknown): string {
  let t = String(input ?? "");
  for (const re of SECRET_PATTERNS) t = t.replace(re, REDACTED.secret);
  // (a truncated address, «amira@example» cut at a dot by a topic parser, is still an address)
  t = t.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*/g, REDACTED.email);
  t = t.replace(/\bhttps?:\/\/[^\s)»"']+/gi, REDACTED.link).replace(/\bwww\.[^\s)»"']+/gi, REDACTED.link);
  // a handle (@name) is a person or an account; a number-like run of 7+ digits (Arabic digits included, separators allowed) is a phone or an id
  t = t.replace(/(?<![A-Za-z0-9_.])@[A-Za-z0-9_.]{2,}/g, REDACTED.handle);
  // (a dot is not a phone separator, so a decimal such as 0.00526 is kept; an ISO day such as 2026-11-11 is a date, not a number)
  // (a run glued to letters is an id such as msn_a254618740b9b…, not a phone)
  t = t.replace(/(?<![A-Za-z_0-9٠-٩۰-۹])\+?[0-9٠-٩۰-۹][0-9٠-٩۰-۹\s()-]{5,}[0-9٠-٩۰-۹](?![A-Za-z_])/g, (m) => (/^\d{4}-\d{1,2}-\d{1,2}$/.test(m.trim()) ? m : digitsOf(m).replace(/\D/g, "").length >= 7 ? REDACTED.phone : m));
  return t;
}

/** Every string inside a value redacted (keys are kept; they are code names). Never mutates its input. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)])) as unknown as T;
  return value;
}

/** True when a text still contains something this module would redact (the tests' leak check on the final output). */
export const leaksIdentity = (text: string): boolean => redactText(text) !== text;
