/**
 * WHAT THE E-MAIL AND PHONE FINDERS REALLY DO, MEASURED (replaces the guessed FALLBACK_MISS_SHARE 0.1 and EMAIL_FOUND_SHARE 0.8 of contactFinders.ts). The source is the platform's own call log, `mission_calls`, read with SELECT on 2026-11-01 (every phase, every mission that called a
 * finder): `calls` = calls made, `hits` = calls the provider BILLED for an answer (these finders bill a found value only: «billed on success only», a miss and a phone-only answer are free). Missions: blitz e-mail 8, blitz phone 3, quickenrich e-mail 3, quickenrich phone 4, anyapi 4, the others 1 to 4 each.
 *   SELECT endpoint_id, count(*) calls, count(*) filter (where status='ok' and cost_usd>0) hits FROM mission_calls WHERE endpoint_id ~ '(email|phone)' GROUP BY 1;
 * Update the numbers from the same query when more missions have run; nothing else in the code carries a guess.
 */
export const MEASURED_FINDER_CALLS: Readonly<Record<string, { calls: number; hits: number }>> = {
  // e-mail finders
  "blitzapi.people.email.find": { calls: 42, hits: 9 },
  "quickenrich.people.email.find": { calls: 14, hits: 0 },
  "anyapi.linkedin.email.work.find": { calls: 5, hits: 5 },
  "aiark.people.email.find": { calls: 2, hits: 0 },
  "dropleads.people.email.find": { calls: 1, hits: 1 },
  "hunter.people.email.find": { calls: 2, hits: 0 },
  "tomba.people.email.find": { calls: 1, hits: 0 },
  "tomba.people.email.find.linkedin": { calls: 4, hits: 1 },
  "trykitt.people.email.find": { calls: 1, hits: 0 },
  // phone finders
  "blitzapi.people.phone.find": { calls: 21, hits: 2 },
  "quickenrich.people.phone.find": { calls: 11, hits: 0 },
  "aiark.people.phone.find": { calls: 3, hits: 1 },
  "dropleads.people.phone.find": { calls: 1, hits: 0 },
  "tomba.people.phone.find": { calls: 2, hits: 1 },
};

export type FinderKindName = "email" | "phone";
const kindOf = (id: string): FinderKindName => (id.includes(".phone.") ? "phone" : "email");

/** The hit rate of the whole kind (every measured finder together), smoothed. */
export function pooledHitRate(kind: FinderKindName): number {
  let calls = 0;
  let hits = 0;
  for (const [id, m] of Object.entries(MEASURED_FINDER_CALLS)) if (kindOf(id) === kind) { calls += m.calls; hits += m.hits; }
  return (hits + 0.5) / (calls + 1);
}

/**
 * THE SHARE OF PERSONS A FINDER GIVES A VALUE FOR: (hits + 0.5) / (calls + 1) from its own measured calls (never 0 and never 1: a finder asked ten times is not certain either way), else the pooled rate of its kind for a finder nobody has called yet.
 */
export function finderHitRate(endpointId: string, kind: FinderKindName): number {
  const m = MEASURED_FINDER_CALLS[endpointId];
  return m ? (m.hits + 0.5) / (m.calls + 1) : pooledHitRate(kind);
}
