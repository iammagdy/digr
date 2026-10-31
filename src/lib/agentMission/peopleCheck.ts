import type { TregCatalog } from "../treg/catalog";
import { MAILBOX_LISTER_CAPABILITIES } from "./childSources";
import { requestWantsContacts } from "./contacts";
import { isPeopleStage } from "./people";
import { rankEndpoints } from "./sourceRanking";

/**
 * THE PEOPLE AND THEIR PHONES: what the plan must have tried before it settles. Live retest 2026-10-31 (A1, A2): the people stage of the plan read «the addresses found on a domain» (a MAILBOX lister), eight of nine rows had no name and none had a title; the
 * catalog's real people sources were sampled and given up (A1: one gave five named people and was not used; A2: three were refused for the planning budget and never read); phones were dropped with a sentence although no phone source had been sampled for the
 * people found. Pure: the plan, the request and what the mission REALLY called in, advice (the planner's tool answers with it) out. The plan is never refused for good: each piece of advice is a step the planner can take, the tool sends the plan back a few
 * times at most, and a plan that has really tried the sources and says so honestly is accepted.
 *   1. The people stage must read PEOPLE: a stage on a mailbox lister is sent back while a people source gave rows (use it) or fewer than two people sources were tried.
 *   2. A phone asked for is in the plan (a phone column on a stage) when a phone source gave a number; else a phone source was tried for the people found (the planning allows ONE phone finder sample: contactSampling.ts; a refused one counts as tried); else the plan says honestly that no number was found.
 *   3. No personal number, but the companies' own page carries a company phone: it goes in the company sheet.
 */
export const PHONE_CAPABILITIES: ReadonlySet<string> = new Set(["people.phone.find", "people.phone.find.personal"]);

/** The catalog's phone finders this account may buy, cheapest first (by the same ranking as every source). */
export function phoneSourcesOf(catalog: TregCatalog, isAllowed: (id: string) => boolean, now = Date.now()): Array<{ id: string; usdPerItem: number; effectiveUsd: number }> {
  const group = catalog.endpoints.filter((e) => e.capability && PHONE_CAPABILITIES.has(e.capability) && isAllowed(e.id));
  return rankEndpoints(group, catalog, new Map(), now).ranked.map((r) => ({ id: r.id, usdPerItem: r.usdPerItem, effectiveUsd: r.effectiveUsd }));
}

export interface CheckStage { key: string; title_ar: string; endpoint_id: string; parent_key: string | null; deliver: boolean; columns: ReadonlyArray<{ key: string; title_ar: string; kind?: string }>; role_preference?: unknown }
export interface PeopleCheckInput {
  plan: { stages: ReadonlyArray<CheckStage>; assumptions_ar?: ReadonlyArray<string>; notes_ar?: ReadonlyArray<string> };
  requestText: string;
  capabilityOf(endpointId: string): string | null;
  /** The people sources of a company this account may buy, cheapest first. */
  peopleSources: ReadonlyArray<string>;
  /** The phone finders this account may buy, cheapest first. */
  phoneSources: ReadonlyArray<string>;
  /** The endpoints the mission called (any outcome, a call refused for the budget included) and the most rows one call of each gave. */
  calls: ReadonlyMap<string, { rows: number }>;
  /** The text of the pages a stage's sample was read from (the company stage's measured page), to see whether the source carries a company phone. */
  evidenceOf?(stageKey: string): string | null;
}

const PHONE_COLUMN = /(?:phone|mobile|telephone|\btel\b|هاتف|تليفون|تلفون|موبايل|جوال|محمول)/i;
const PHONE_VALUE = /"(?:phone|phone_?number|telephone|tel|mobile|contact_?phone|company_?phone|phones?)"\s*:\s*"\+?\d[\d\s().-]{6,}"/i;
const PHONE_SAID = /(?:تليفون|هاتف|أرقام|ارقام|موبايل|جوال|محمول)/;
const top = (ids: ReadonlyArray<string>, n = 4): string => ids.slice(0, n).join(", ");

export function peopleAndContactAdvice(i: PeopleCheckInput): string[] {
  const issues: string[] = [];
  const stages = i.plan.stages;
  const wants = requestWantsContacts(i.requestText);
  const tried = (ids: ReadonlyArray<string>) => ids.filter((id) => i.calls.has(id));
  const rowsOf = (id: string) => i.calls.get(id)?.rows ?? 0;

  // 1. THE PEOPLE STAGE READS PEOPLE
  const peopleTried = tried(i.peopleSources);
  const peopleGaveRows = peopleTried.filter((id) => rowsOf(id) > 0);
  for (const st of stages.filter((s) => s.deliver && isPeopleStage(s))) {
    const capability = i.capabilityOf(st.endpoint_id);
    if (!capability || !MAILBOX_LISTER_CAPABILITIES.has(capability)) continue;
    if (peopleGaveRows.length > 0) {
      issues.push(`stage «${st.key}» reads the people of the companies from an e-mail lister: its rows are mailboxes, and most of the mailboxes of a small company are role addresses (info@, sales@, webmaster@) with no person's name, which are never delivered as people. A people source of the catalog already gave named people: ${top(peopleGaveRows)}. Use a people source for this stage (names and job titles come from it); the e-mail and the phone of each person follow as contact steps, and the company's own mailboxes are kept for the company's sheet by code`);
    } else if (peopleTried.length < 2) {
      const untried = i.peopleSources.filter((id) => !i.calls.has(id));
      issues.push(`stage «${st.key}» reads the people of the companies from an e-mail lister: its rows are mailboxes, many with no person's name (never delivered as people). Names and job titles come from a PEOPLE source: sample at least two of them before settling for anything else, cheapest first${untried.length ? `: ${top(untried)}` : ""}. A call refused for the planning budget is not a sample: take the next one`);
    }
  }

  // 2. THE PHONE THAT WAS ASKED FOR IS IN THE PLAN, OR THE PLAN SAYS HONESTLY WHY NOT
  const hasPhoneColumn = stages.some((s) => s.columns.some((c) => c.kind === "phone" || PHONE_COLUMN.test(c.key) || PHONE_COLUMN.test(c.title_ar)));
  if (wants.phone && !hasPhoneColumn) {
    const phoneTried = tried(i.phoneSources);
    const phoneGaveRows = phoneTried.filter((id) => rowsOf(id) > 0);
    const untried = i.phoneSources.filter((id) => !i.calls.has(id));
    const said = [...(i.plan.assumptions_ar ?? []), ...(i.plan.notes_ar ?? [])].some((l) => PHONE_SAID.test(l));
    if (phoneGaveRows.length > 0) issues.push(`the customer asked for phones and a phone source gave a number (${top(phoneGaveRows)}), but the plan has no phone column: add the phone as a step of the people found (a child stage whose column has kind "phone"; its values are verified by code) instead of dropping it`);
    else if (phoneTried.length < 1 && untried.length > 0) issues.push(`the customer asked for phones, and the catalog has phone sources that were not sampled for the people found. Sample one phone finder with a person of your people sample (the profile link, or the name with the company), the cheapest ranked first: ${top(untried)}; add the phone step if it gives a number. The planning allows one phone finder sample (a quarter of its budget in all, never a finder whose one call costs more than that): a finder the gateway refuses is counted as tried and is not chased. If no phone was found the plan says so, and says that the phone cells are filled only if found during the approved job`);
    else if (!said) issues.push("the customer asked for phones, a phone source was tried (or refused for the planning allowance) and gave none, and the plan does not say so: say honestly in assumptions_ar (one Arabic sentence, no number) that phone numbers are not in the file and why, so the card tells the customer before approval; never drop the phones silently");
  }

  // 3. NO PERSONAL NUMBER, BUT A COMPANY PHONE ON THE COMPANIES' OWN PAGE: it goes in the company sheet
  if (wants.phone && !hasPhoneColumn && i.evidenceOf) {
    for (const st of stages.filter((s) => s.deliver && s.parent_key === null)) {
      const text = i.evidenceOf(st.key);
      if (text && PHONE_VALUE.test(text)) { issues.push(`the companies' source of stage «${st.key}» carries a company phone and the plan has no phone column: add a company phone column to that stage (kind "phone"), so the company sheet holds the company's number where no personal number is found`); break; }
    }
  }
  return issues;
}
