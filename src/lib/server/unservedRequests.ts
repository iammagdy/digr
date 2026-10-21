import { COVERAGE_FAMILIES, familyById, type FamilyId } from "../requestCoverage";

/**
 * The requests the platform could not serve or served only in part, as the chat stores them in `capability_requests`
 * (`query` = «family+family: the customer's words»). Pure: shapes rows the admin route reads (SELECT only) for the owner's small list.
 */
export interface UnservedRow { id: string; user_id: string | null; query: string | null; created_at: string | null }

export interface UnservedItem { id: string; at: string | null; families: FamilyId[]; familiesAr: string[]; textAr: string }

const KNOWN = new Set<string>(COVERAGE_FAMILIES.map((family) => family.id));

export function parseUnservedRow(row: UnservedRow): UnservedItem {
  const raw = String(row.query ?? "");
  const split = raw.indexOf(":");
  const head = split > 0 ? raw.slice(0, split) : "";
  const families = head.split("+").map((value) => value.trim()).filter((value): value is FamilyId => KNOWN.has(value));
  const textAr = (families.length > 0 ? raw.slice(split + 1) : raw).trim();
  return { id: row.id, at: row.created_at, families, familiesAr: families.map((id) => familyById(id).titleAr), textAr };
}

export interface UnservedSummary { total: number; byFamily: Array<{ family: FamilyId | "other"; titleAr: string; count: number }>; items: UnservedItem[] }

/** Counts per family, most asked first: what customers want that the platform does not sell. */
export function summarizeUnserved(rows: readonly UnservedRow[]): UnservedSummary {
  const items = rows.map(parseUnservedRow);
  const counts = new Map<FamilyId | "other", number>();
  for (const item of items) {
    const keys: Array<FamilyId | "other"> = item.families.length > 0 ? item.families : ["other"];
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const byFamily = [...counts.entries()]
    .map(([family, count]) => ({ family, titleAr: family === "other" ? "طلبات أخرى لم تُخدم" : familyById(family).titleAr, count }))
    .sort((a, b) => b.count - a.count);
  return { total: items.length, byFamily, items };
}
