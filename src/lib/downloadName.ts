/**
 * THE NAME A DOWNLOAD IS SAVED UNDER (round 20). A name in Arabic must reach the browser as `filename*=UTF-8''<percent-encoded>` (RFC 6266 / RFC 5987) with a plain ASCII `filename="..."` beside it for a client that does not read the star form.
 * Written once and used by every route that serves a file; pure and isomorphic (no Next, no Node), so the site's own pages read a name back with the same code that wrote it.
 */
const MAX_NAME_CHARS = 150;
export const FALLBACK_BASE = "diger-results";

/** A name that is safe to put in a header: no control character, no path separator, no quote (those would end the value or add a parameter). The characters themselves are kept (Arabic included). */
function cleanName(name: string): string {
  const cleaned = String(name ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "")
    .replace(/[\\/"]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

const splitExt = (name: string): { base: string; ext: string } => {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,8})$/.exec(name);
  return m && m[1] !== "" ? { base: m[1], ext: m[2] } : { base: name, ext: "" };
};

/** The name cut to a length a header can carry, by whole characters (never half of one), the extension kept. */
function capName(name: string): string {
  const { base, ext } = splitExt(name);
  const chars = Array.from(base);
  const room = Math.max(1, MAX_NAME_CHARS - Array.from(ext).length);
  return chars.length > room ? `${chars.slice(0, room).join("").trim()}${ext}` : name;
}

/** The plain ASCII name: only letters, digits and a few marks survive; a name with no ASCII letter or digit at all becomes `diger-results` (an underscore-only name tells the customer nothing). The extension is kept. */
export function asciiFallbackNameOf(name: string): string {
  const { base, ext } = splitExt(cleanName(name));
  const ascii = base.replace(/[^A-Za-z0-9 ._()+,@#&~!-]/g, "").replace(/ {2,}/g, " ").trim();
  return `${/[A-Za-z0-9]/.test(ascii) ? ascii : FALLBACK_BASE}${ext}`;
}

/** RFC 5987 value: percent-encoded UTF-8; encodeURIComponent leaves `' ( ) *` alone and the star form does not allow them. */
const encodeStar = (name: string): string => encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `attachment; filename="<ASCII>"; filename*=UTF-8''<percent-encoded name>`. */
export function contentDispositionOf(name: string, disposition: "attachment" | "inline" = "attachment"): string {
  const full = capName(cleanName(name)) || FALLBACK_BASE;
  return `${disposition}; filename="${asciiFallbackNameOf(full)}"; filename*=UTF-8''${encodeStar(full)}`;
}

/** The name a `Content-Disposition` header carries: `filename*` (UTF-8) first, else the plain `filename` (quoted or not), else null. */
export function fileNameFromDisposition(header: string | null | undefined): string | null {
  const value = String(header ?? "");
  const star = /filename\*\s*=\s*([A-Za-z0-9-]+)'[^']*'([^;]+)/i.exec(value);
  if (star && /^utf-?8$/i.test(star[1])) {
    try { return decodeURIComponent(star[2].trim()); } catch { /* fall through to the plain name */ }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(value.replace(/filename\*\s*=\s*[^;]+;?/gi, ""));
  const name = plain ? (plain[1] ?? plain[2] ?? "") : "";
  return name !== "" ? name : null;
}

/** The type a file of this name is served as. */
export function contentTypeOfName(name: string): string {
  switch (String(name).toLowerCase().split(".").pop()) {
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "csv": return "text/csv; charset=utf-8";
    case "pdf": return "application/pdf";
    case "json": return "application/json; charset=utf-8";
    case "zip": return "application/zip";
    default: return "application/octet-stream";
  }
}
