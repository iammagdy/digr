import type { PeopleSource } from "./childSources";

/**
 * THE ESTIMATE OF A PEOPLE STAGE (DT-20261119-01; owner decisions D-0103 and D-0107). When the small sample before the card asked a people source for the people of the companies and it answered EMPTY, the card used to be impossible
 * (a stage must cite a measured call with rows). The price of the reading of a person is then an ESTIMATE derived by code from the catalog the planner already ranks (no provider name in code, D-0086):
 *
 *   table  = the people-of-company sources this account may buy, ranked as the planner ranks them (price per item over the chance of rows, health demotions applied), keeping those whose effective cost per person is at most PEOPLE_ESTIMATE_MAX_USD
 *   E      = the DEARIEST of the next PEOPLE_ESTIMATE_GROUP sources of the table that were not already tried and empty in this planning (the execution walks the same ranked chain)
 *   stage  = costPerRowUsd E (the finder steps' own cost per person is added by the one price rule, as for a measured stage)
 *
 * An empty table (every source above the ceiling or already tried empty) is no estimate: no card. Nothing here touches the price rule, the hold or the cap: the estimate only enters where a measured cost enters today.
 */
export const PEOPLE_ESTIMATE_MAX_USD = 0.02;
export const PEOPLE_ESTIMATE_GROUP = 3;

export interface PeopleEstimate {
  /** The sources the estimated stage may use: the table without the ones already tried and empty, cheapest first. */
  endpointIds: string[];
  /** The estimated cost of reading one person, USD (what the stage's cost per row is). */
  costPerPersonUsd: number;
  /** The dearest source of the table, USD per person: the most the reading of a person can cost (kept for the admin; never shown to the customer). */
  ceilingPersonUsd: number;
}

/** `ranked`: peopleSourcesForCompanies (already allowed and ranked); `triedEmpty`: the ids of the people sources that answered EMPTY in this planning. Null when there is nothing left to estimate from. */
export function peopleEstimateOf(ranked: ReadonlyArray<Pick<PeopleSource, "id" | "effectiveUsd">>, triedEmpty: ReadonlySet<string>): PeopleEstimate | null {
  const table = ranked.filter((s) => Number.isFinite(s.effectiveUsd) && s.effectiveUsd > 0 && s.effectiveUsd <= PEOPLE_ESTIMATE_MAX_USD);
  const left = table.filter((s) => !triedEmpty.has(s.id));
  if (left.length === 0) return null;
  const group = left.slice(0, PEOPLE_ESTIMATE_GROUP);
  return { endpointIds: left.map((s) => s.id), costPerPersonUsd: Math.max(...group.map((s) => s.effectiveUsd)), ceilingPersonUsd: Math.max(...table.map((s) => s.effectiveUsd)) };
}

export interface PeopleCallRow { endpoint_id: string; status: string; rows_returned: number | null }

/**
 * THE CONDITIONS OF AN ESTIMATED CARD, read by code from the calls of this planning (never from the model's word): at least one people source ANSWERED (status ok with no rows, or empty) and NO people source gave a row
 * (then the measured path applies, unchanged). A call that failed or was refused is not an answer: the honest end of DT-09 F2 applies, no card.
 */
export function peopleAnswersOf(calls: ReadonlyArray<PeopleCallRow>, peopleIds: ReadonlySet<string>): { answeredEmpty: Set<string>; gaveRows: boolean } {
  const answeredEmpty = new Set<string>();
  let gaveRows = false;
  for (const c of calls) {
    if (!peopleIds.has(c.endpoint_id)) continue;
    const rows = Number(c.rows_returned ?? 0);
    if ((c.status === "ok" || c.status === "empty") && rows > 0) gaveRows = true;
    else if (c.status === "empty" || (c.status === "ok" && rows === 0)) answeredEmpty.add(c.endpoint_id);
  }
  return { answeredEmpty, gaveRows };
}

/** The card's note on an estimated people stage (customer text: Arabic only, no number, no provider; it promises only what the settlement proves: the charge is the delivered rows at their own price, the companies alone when no person is delivered, and the rest of the hold is released). */
export const PEOPLE_ESTIMATE_NOTE_AR = "لم تظهر أي أسماء لهؤلاء الأشخاص في العينة الصغيرة، فسعر هذه المرحلة تقديري وهو أقصى ما قد يُحسب. لن تدفع إلا مقابل ما يُسلَّم فعلًا، وإن لم يُسلَّم أي شخص فلن تدفع إلا ثمن الشركات، وما لا يُسلَّم يُحرَّر من الحجز.";
