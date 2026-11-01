/**
 * A COMPANY NAME THAT IS ONLY A DOMAIN. A company source sometimes has no name for a company and gives its website instead («al-hashemiah.com.eg», «ecom.com.eg»). The «اسم الشركة» cell then holds a web address.
 * Code replaces it with another NAME field of the same item when the item has one (a legal name, a display name, a brand), and otherwise leaves it exactly as the source gave it: nothing is invented from the domain, the link or the description.
 * Pure: no I/O.
 */
import { cleanedName, nameHasDebris } from "./entityDoubts";

const DOMAIN_ONLY = /^(?:https?:\/\/)?(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}\/?$/i;
const NAME_COLUMN = /(^|_)(name|company_name|companyname|title)$/i;
const OTHER_NAME_FIELD = /(^|_)(legal_?name|company_?name|display_?name|trade_?name|brand_?name|brand|short_?name|full_?name|official_?name|name_?(?:ar|en)|alias|alternative_?names?|former_?names?)$/i;

/** True when the whole value is a web address or a domain and nothing else (no space, no other word). */
export const isDomainOnly = (value: unknown): boolean => typeof value === "string" && value.trim().length > 3 && DOMAIN_ONLY.test(value.trim());

const textOf = (v: unknown): string | null => {
  const t = Array.isArray(v) ? v.find((x) => typeof x === "string" && x.trim()) : v;
  return typeof t === "string" && t.trim() && !isDomainOnly(t) ? t.trim() : null;
};

/** The item with every name column that is only a domain replaced by another name field of the item; the same object when nothing changes. */
export function withRealName<T extends Record<string, unknown>>(item: T, columns: ReadonlyArray<{ key: string; title_ar?: string }>): T {
  let out: T | null = null;
  for (const col of columns) {
    if (!NAME_COLUMN.test(col.key) && !/^اسم\s/.test(String(col.title_ar ?? ""))) continue;
    if (!isDomainOnly(item[col.key])) continue;
    const other = Object.keys(item).filter((k) => k !== col.key && OTHER_NAME_FIELD.test(k)).map((k) => textOf(item[k])).find((t) => t !== null);
    if (other) { out = out ?? ({ ...item } as T); (out as Record<string, unknown>)[col.key] = other; }
  }
  return out ?? item;
}

/** The item with every name column that is a BROKEN SPREADSHEET LINE («serious construction "sc",,11-50,seriouscons.com») cut back to the name inside it; `debris` says that one was. The other fields of such an item may be another company's: the caller sends it to the model check. */
export function withCleanName<T extends Record<string, unknown>>(item: T, columns: ReadonlyArray<{ key: string; title_ar?: string }>): { item: T; debris: boolean } {
  let out: T | null = null;
  let debris = false;
  for (const col of columns) {
    if (!NAME_COLUMN.test(col.key) && !/^اسم\s/.test(String(col.title_ar ?? ""))) continue;
    if (!nameHasDebris(item[col.key])) continue;
    debris = true;
    const name = cleanedName(String(item[col.key]));
    if (name) { out = out ?? ({ ...item } as T); (out as Record<string, unknown>)[col.key] = name; }
  }
  return { item: out ?? item, debris };
}

/** The mapped fields (keys) of a stage's columns that hold the company's name. */
export const nameKeysOf = (columns: ReadonlyArray<{ key: string; title_ar?: string }>): string[] => columns.filter((c) => NAME_COLUMN.test(c.key) || /^اسم\s/.test(String(c.title_ar ?? ""))).map((c) => c.key);

/**
 * A COMPANY NAME AS THE CUSTOMER READS IT (live 2026-11-01: «mitsubishi elevators \ melco-mec egypt» with its backslash in the file and in the map query built from it): stray backslashes and quotation marks are taken out (a backslash that separated two names becomes a space),
 * spaces collapse, and separators left at the start or the end («,», «;», «:», «|», «/», «-») are cut. A clean name (an apostrophe, a dot or a hyphen inside it, parentheses) is returned as it was.
 */
export function tidyCompanyName(value: string): string {
  return String(value ?? "")
    .replace(/\\+/g, " ")
    .replace(/["“”„‟«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s,;:|/\-–—·]+|[\s,;:|/\-–—·]+$/g, "")
    .trim();
}

const COMPANY_CELL = /^(company|company_name|companyname)$/i;
/** The item with its COMPANY NAME cells tidied: the name columns of a stage of companies, and the company cell of any stage (a people row says which company the person is at). A person's own name is never touched. The same object when nothing changes. */
export function withTidyNames<T extends Record<string, unknown>>(item: T, columns: ReadonlyArray<{ key: string; title_ar?: string }>, isChild: boolean): T {
  let out: T | null = null;
  const keys = new Set<string>(Object.keys(item).filter((k) => COMPANY_CELL.test(k)));
  if (!isChild) for (const k of nameKeysOf(columns)) keys.add(k);
  for (const k of keys) {
    const v = item[k];
    if (typeof v !== "string") continue;
    const t = tidyCompanyName(v);
    if (t !== v) { out = out ?? ({ ...item } as T); (out as Record<string, unknown>)[k] = t; }
  }
  return out ?? item;
}
