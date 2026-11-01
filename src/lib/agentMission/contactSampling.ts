import { PHONE_CAPABILITIES } from "./peopleCheck";

/**
 * CONTACT-FINDER SAMPLES MAY NOT STARVE PLANNING. Live re-test 2026-10-31 (A1): 79.8% of the planning source spend (0.0555 of 0.0696 USD) went to e-mail and phone finder samples, one phone sample alone 0.0445, and the planning ran out of budget before the
 * stages were sampled («planning_over_budget»: the customer read «بسبب حد من جانبنا»). A finder is only a SAMPLE during planning (the approved job calls it for every person it needs), so the planning pays for the least that tells the planner the source works:
 *   - at most a quarter of the planning budget in all (CONTACT_SAMPLE_SHARE);
 *   - one sample per kind (e-mail, phone): a call that was made counts, whatever it gave;
 *   - the cheapest ranked finder of the kind first (the one the ranking puts first among those whose single call fits inside the quarter);
 *   - never a finder whose single call costs more than that quarter. This limits SAMPLING only: the finder step is in the plan by code (contactFinders.ts) whatever was or was not sampled.
 * Pure: the gateway asks it before it spends. Platform planning spend, not the customer's money: nothing here touches the ledger, a price or a cap.
 */
export const CONTACT_SAMPLE_SHARE = 0.25;
export type ContactFinderKind = "email" | "phone";
export const EMAIL_FINDER_CAPABILITIES: ReadonlySet<string> = new Set(["people.email.find", "people.email.find.personal"]);

/** The kind of contact a source finds, from its capability; null for every other source (an e-mail LISTER of a domain, a people source, a verifier). */
export function contactFinderKind(capability: string | null | undefined): ContactFinderKind | null {
  const c = String(capability ?? "");
  if (EMAIL_FINDER_CAPABILITIES.has(c)) return "email";
  if (PHONE_CAPABILITIES.has(c)) return "phone";
  return null;
}

/** The most the planning may spend on contact-finder samples in all (USD), or null when the planning has no budget figure (then only the one-per-kind rule applies). */
export function contactSampleCapUsd(planningBudgetUsd: number | null | undefined): number | null {
  const b = Number(planningBudgetUsd);
  return Number.isFinite(b) && b > 0 ? Number((b * CONTACT_SAMPLE_SHARE).toFixed(6)) : null;
}

export type ContactSampleRefusal = "kind_sampled" | "too_dear" | "over_cap" | "cheapest_first";
export interface ContactSampleInput {
  kind: ContactFinderKind;
  /** What this call may cost (USD), by the gateway's estimate. */
  estimateUsd: number;
  capUsd: number | null;
  /** The kinds a finder was already called for in this mission (recorded calls included). */
  sampledKinds: ReadonlySet<ContactFinderKind>;
  /** USD already spent on contact-finder samples in this mission. */
  spentOnContactUsd: number;
  /** The endpoint of this call and the cheapest ranked finder of its kind that fits inside the cap (null: none fits). */
  endpointId: string;
  cheapestId: string | null;
}

/** Null when the sample may be made; otherwise why not. The order is the order of the cheapest explanation: kind already sampled, a finder too dear, the quarter spent, a cheaper ranked finder first. */
export function contactSampleRefusal(i: ContactSampleInput): ContactSampleRefusal | null {
  if (i.sampledKinds.has(i.kind)) return "kind_sampled";
  if (i.capUsd !== null && i.estimateUsd > i.capUsd + 1e-9) return "too_dear";
  if (i.capUsd !== null && i.spentOnContactUsd + i.estimateUsd > i.capUsd + 1e-9) return "over_cap";
  if (i.cheapestId !== null && i.cheapestId !== i.endpointId) return "cheapest_first";
  return null;
}

const KIND_WORD: Record<ContactFinderKind, string> = { email: "e-mail", phone: "phone" };

/** What the planner is told (English, for the model only, never shown to a customer). */
export function contactSampleMessage(refusal: ContactSampleRefusal, kind: ContactFinderKind, cheapestId: string | null): string {
  const w = KIND_WORD[kind];
  const cells = `do not sample it: the planning keeps its budget for the stages of the plan. The ${w} finder step for the people of the plan is added to the plan by code and is carried out in the approved job for every person delivered, whatever is sampled here: do not plan it, do not drop the ${w} column, and do not write that the ${w} cells may stay empty`;
  if (refusal === "kind_sampled") return `a ${w} finder was already sampled in this mission (one sample per kind is enough to plan with): ${cells}`;
  if (refusal === "too_dear") return `one call of this ${w} finder costs more than a quarter of the planning budget, so it is never sampled during planning: ${cells}`;
  if (refusal === "over_cap") return `the planning has already spent a quarter of its budget on contact finders: ${cells}`;
  return `a cheaper ${w} finder ranks first and must be sampled before any other, so this call was NOT made; sample the cheapest ranked one first: ${cheapestId ?? "none"}`;
}
