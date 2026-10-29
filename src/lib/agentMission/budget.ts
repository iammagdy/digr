import { AGENT_PLANNING_BUDGET_MULTI_STAGE_USD, AGENT_PLANNING_BUDGET_USD } from "./constants";
import { requestWantsContacts } from "./contacts";

/**
 * The planning (exploration) budget of one mission, in USD of source calls. A request that asks for a parent AND its children (posts and their comments, companies and their employees, a place and its
 * reviews, people and their e-mails or phones) is multi-stage: it needs a sample of every stage, so it gets AGENT_PLANNING_BUDGET_MULTI_STAGE_USD (0.10); every other request keeps AGENT_PLANNING_BUDGET_USD (0.05).
 * Decided by code from the customer's words; the model cannot raise it. An owner cost, never charged to the customer.
 */
const RELATION_WORDS = /(?:تعليق|تعليقات|ردود|موظف|موظفين|العاملين|مدير|مديري|أشخاص|اشخاص|مراجعات|تقييمات|لكل\s|وجوه|داخل كل|جوه كل|comments?|replies|employees?|people|reviews?|each\s|per\s)/i;

export function isMultiStageRequest(text: unknown): boolean {
  const t = String(text ?? "");
  const contacts = requestWantsContacts(t);
  return contacts.email || contacts.phone || RELATION_WORDS.test(t);
}

export const planningBudgetUsd = (requestText: unknown): number => (isMultiStageRequest(requestText) ? AGENT_PLANNING_BUDGET_MULTI_STAGE_USD : AGENT_PLANNING_BUDGET_USD);

/** How many stages the request will need (each needs a sample while planning): two for a parent and its children, else one. Decided by code from the customer's words. */
export const expectedStageCount = (requestText: unknown): number => (isMultiStageRequest(requestText) ? 2 : 1);
