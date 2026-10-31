/**
 * PII masking for everything that is shown to the model. The model gets column HEADERS, counts and at most 5 masked sample values per column; a raw cell value never
 * leaves the server. Every function here is pure and deterministic.
 *   e-mail   a***@d***.com        (first letter of the name, first letter of the domain, the last label kept)
 *   phone    010****123           (first 3 and last 3 digits; fewer than 8 digits: all masked)
 *   number   a long digit string (an ID) is masked like a phone; a short number (a row number) is kept
 *   name/text each word reduced to its first letter:  «أحمد محمد علي» -> «أ. م. ع.»
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const firstChar = (s: string): string => Array.from(s)[0] ?? "";

export const looksLikeEmail = (v: string): boolean => EMAIL.test(v.trim());

/** digits of a value, Arabic-Indic and Persian digits included */
export const digitsOf = (v: string): string =>
  v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/\D/g, "");

export function looksLikePhone(v: string): boolean {
  const t = v.trim();
  if (t === "" || /[A-Za-zء-ي@]/.test(t)) return false;
  const digits = digitsOf(t);
  return digits.length >= 7 && digits.length <= 13 && digits.length >= t.replace(/[\s+\-().]/g, "").length - 1;
}

export function maskEmail(v: string): string {
  const [name, domain = ""] = v.trim().split("@");
  const labels = domain.split(".");
  const tld = labels.length > 1 ? `.${labels[labels.length - 1]}` : "";
  const host = labels.length > 1 ? labels.slice(0, -1).join(".") : domain;
  return `${firstChar(name)}***@${firstChar(host)}***${tld}`;
}

export function maskPhone(v: string): string {
  const d = digitsOf(v);
  if (d.length < 8) return "*".repeat(Math.max(d.length, 4));
  return `${d.slice(0, 3)}****${d.slice(-3)}`;
}

/** a long digit string that is not a phone (an ID, an account number): first 2 and last 2 digits */
function maskLongDigits(v: string): string {
  const d = digitsOf(v);
  return `${d.slice(0, 2)}****${d.slice(-2)}`;
}

export function maskName(v: string): string {
  const words = v.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  return words.map((w) => `${firstChar(w)}.`).join(" ");
}

/** One sample value, masked by what it looks like. Empty stays empty. */
export function maskCell(value: string): string {
  const v = String(value ?? "").trim();
  if (v === "") return "";
  if (v.includes("@")) return looksLikeEmail(v) ? maskEmail(v) : maskName(v.replace(/@/g, " "));
  if (looksLikePhone(v)) return maskPhone(v);
  const digits = digitsOf(v);
  if (digits.length > 0 && digits.length === v.replace(/[\s,.\-]/g, "").length) return digits.length >= 5 ? maskLongDigits(v) : v;
  if (digits.length >= 7) return maskName(v.replace(/\d/g, " ")) || "*";
  return maskName(v);
}

/**
 * A column header. Headers are usually labels («الشركة»), but a file without a header row makes the first DATA row the header, so a header that looks like data is
 * masked exactly like a cell; a normal label is kept (shortened to 60 characters).
 */
export function maskHeader(value: string): string {
  const v = String(value ?? "").trim().replace(/\s+/g, " ");
  if (v === "") return "";
  if (v.includes("@") || looksLikePhone(v) || digitsOf(v).length >= 5) return maskCell(v);
  return Array.from(v).slice(0, 60).join("");
}
