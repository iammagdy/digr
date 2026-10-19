/**
 * Which job a reloaded conversation shows. The candidates are the jobs derived from the conversation's quote cards, oldest
 * first. A plan card the customer never approved has no job, so choosing the LAST candidate blindly (what the page did)
 * picked a job that does not exist and left the page without an active job: the custom-file buttons need one.
 * The latest candidate whose job exists wins; when none exists the last candidate is kept, as before.
 */
export function pickRestoredJobId(candidates: string[], existingIds: ReadonlySet<string>, targetJobId?: string | null): string | undefined {
  if (targetJobId) return candidates.includes(targetJobId) ? targetJobId : undefined;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (existingIds.has(candidates[index])) return candidates[index];
  }
  return candidates[candidates.length - 1];
}
