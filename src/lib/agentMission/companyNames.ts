/**
 * A COMPANY NAME THAT IS ONLY A DOMAIN. A company source sometimes has no name for a company and gives its website instead («al-hashemiah.com.eg», «ecom.com.eg»). The «اسم الشركة» cell then holds a web address.
 * Code replaces it with another NAME field of the same item when the item has one (a legal name, a display name, a brand), and otherwise leaves it exactly as the source gave it: nothing is invented from the domain, the link or the description.
 * Pure: no I/O.
 */
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
