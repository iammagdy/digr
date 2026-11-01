import { countAr, knownItemNoun } from "../../src/lib/agentMission/itemNoun";
import { titleFieldOf, titleTierOf, type RoleKey } from "../../src/lib/agentMission/roles";

/**
 * THE SHORTFALL OF A CHILD STAGE, FROM THE COUNTS RECORDED PER PARENT (live msn_7539ea17512cf58aa0e7, 2026-11-01: 8 of 10 people delivered; one company had NO people and twelve people were left out as beyond the approved two per company, and the limits row said «المصدر لم يعد يعطي نتائج أخرى لهذا الطلب»).
 * Said from what the item store recorded: the parents (companies) with no delivered child, the parents with fewer than the number asked for each, and the children left out only because the approved number was reached. Null when nothing per parent explains the shortfall (the caller keeps the older, true
 * sentence by the recorded stop reason). Pure: counts in, Arabic out; Arabic-Indic digits, no provider.
 */
export interface PerParentFacts {
  /** The ids of the parents delivered (the companies). */
  parentIds: ReadonlyArray<string>;
  /** The parent id of each delivered child (person). */
  childParentIds: ReadonlyArray<string>;
  /** The number asked for each parent. */
  perParent: number | undefined;
  /** Children left out only because the approved number was reached (the recorded `target_reached`). */
  surplus: number;
  /** The noun of the parent (default «شركة») and of the child (default «شخص»). */
  parentNoun?: string;
  childNoun?: string;
}

export function perParentShortfallAr(f: PerParentFacts): string | null {
  const parentNoun = knownItemNoun(f.parentNoun ?? "شركة");
  const childNoun = knownItemNoun(f.childNoun ?? "شخص");
  if (!parentNoun || !childNoun || f.parentIds.length === 0) return null;
  // delivered rows that name no parent cannot be attributed to a company: nothing per parent can be said
  if (f.childParentIds.length > 0 && f.childParentIds.every((id) => String(id).trim() === "")) return null;
  const counts = new Map<string, number>(f.parentIds.map((id) => [String(id), 0] as const));
  for (const id of f.childParentIds) if (counts.has(String(id))) counts.set(String(id), (counts.get(String(id)) ?? 0) + 1);
  const none = [...counts.values()].filter((n) => n === 0).length;
  const per = f.perParent !== undefined && f.perParent > 0 ? f.perParent : null;
  const fewer = per === null ? 0 : [...counts.values()].filter((n) => n > 0 && n < per).length;
  const surplus = Math.max(0, Math.floor(Number(f.surplus) || 0));
  const parts: string[] = [];
  if (none > 0) parts.push(none === 1 ? `${countAr(1, parentNoun)} لم يُعثر فيها على موظفين` : none === 2 ? `${countAr(2, parentNoun, { subject: true })} لم يُعثر فيهما على موظفين` : `${countAr(none, parentNoun)} لم يُعثر فيها على موظفين`);
  if (fewer > 0) parts.push(fewer === 1 ? `${countAr(1, parentNoun)} وُجد فيها موظفون أقل من العدد المطلوب` : fewer === 2 ? `${countAr(2, parentNoun, { subject: true })} وُجد فيهما موظفون أقل من العدد المطلوب` : `${countAr(fewer, parentNoun)} وُجد فيها موظفون أقل من العدد المطلوب`);
  if (none === 0 && fewer === 0) return null;
  if (surplus > 0) parts.push(`وزاد ${countAr(surplus, childNoun)} عن العدد المعتمد في بقية الشركات`);
  return parts.join("، ");
}

/**
 * THE COMPANIES THAT HAVE NO DECISION MAKER AMONG THEIR DELIVERED PEOPLE (reference A: the note «لم نجد صناع قرار في هذه الشركة», audit 2026-11). Per company, from the delivered people's job titles (roles.ts, tier 0 = a title that names the role): a company with no person at all is marked too (the owner's
 * sheet marks a company the count of which was filled with other employees; none found is the same finding). Only for the decision makers' role. The set of the parent ids to mark.
 */
export function companiesWithoutDecisionMakers(parentIds: ReadonlyArray<string>, people: ReadonlyArray<Record<string, unknown>>, role: RoleKey): Set<string> {
  const out = new Set<string>();
  if (role !== "manager") return out;
  const withDm = new Set<string>();
  for (const p of people) {
    const field = titleFieldOf(p);
    if (field && titleTierOf(p[field], role) === 0) withDm.add(String(p.parent_id ?? ""));
  }
  for (const id of parentIds) if (!withDm.has(String(id))) out.add(String(id));
  return out;
}
