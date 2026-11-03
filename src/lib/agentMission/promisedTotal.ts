/**
 * ONE PROMISED NUMBER EVERYWHERE (live round 10, msn_fc40280193aab21b9201: the orders page said «٤٣ من ٥٩», the chat and the file «٤٣ من ٦٣»). The orders page read the job's own number (the card's total at approval: 2 + 54 + 3 = 59), the chat and the file the plan AS JUDGED at
 * the end of the run, when the replies the card only estimated are judged against the reply counters of the delivered comments (7: 2 + 54 + 7 = 63). A finished mission that has such replies is promised the judged total on every surface; every other mission keeps the job's number. Pure; display only.
 */
export function promisedRowsOf(stages: ReadonlyArray<{ expected_rows?: number; deliver?: boolean; replies_open?: boolean }> | null | undefined, jobTarget: number): number {
  if (!stages || stages.length === 0 || !stages.some((s) => s.replies_open === true)) return jobTarget;
  const total = stages.filter((s) => s.deliver !== false).reduce((n, s) => n + (Number.isFinite(Number(s.expected_rows)) ? Number(s.expected_rows) : 0), 0);
  return total > 0 ? total : jobTarget;
}
