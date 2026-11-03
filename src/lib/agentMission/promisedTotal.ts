/**
 * ONE PROMISED NUMBER EVERYWHERE (live rounds 10 and 11). The orders page read the job's own number (the card's total at approval: Instagram 2 + 38 + 2 = 42, YouTube 220), the chat and the file the plan AS JUDGED at the end of the run, when the replies the
 * card only estimated (and the comments of a source with no counter) are judged against what the source gave (Instagram 2 + 38 + 9 = 49, YouTube 2 + 95 + 4 = 101). Round 10 asked the stages for `replies_open`, but the stages the orders page reads are the PUBLIC
 * plan's (`plan_public->stages`: key, title, expected_rows, deliver, columns), which never carry it; so the function always fell back to the job's number. The public plan is stored again when the run ends, with the judged numbers, and a plan that still waits or runs
 * holds the card's own (the sum is then the job's number): for a compiled plan the promised number is the sum of the delivered stages' `expected_rows` of the public plan, on every surface. Pure; display only; the job row and the money are not touched.
 */
export function promisedRowsOf(stages: ReadonlyArray<{ expected_rows?: number; deliver?: boolean; replies_open?: boolean; children_open?: boolean; replies_counted?: number }> | null | undefined, jobTarget: number, compiled = true): number {
  // compiled plans only (a mission planned the old way keeps the number it always showed)
  if (!compiled || !stages || stages.length === 0) return jobTarget;
  // THE CARD'S OWN RULE (customerView.stagesView, round 14): a stage that promised no number is not in the total (its estimate is only what the price was made from), and the replies the planning counted join it. After the run the public plan is judged (no open stage left), so the sum is the plain one.
  const total = stages.filter((s) => s.deliver !== false).reduce((n, s) => {
    const open = s.replies_open === true || s.children_open === true;
    const rows = Number.isFinite(Number(s.expected_rows)) ? Math.max(0, Math.floor(Number(s.expected_rows))) : 0;
    return n + (open ? (s.replies_open === true && typeof s.replies_counted === "number" ? Math.max(0, Math.floor(s.replies_counted)) : 0) : rows);
  }, 0);
  return total > 0 ? total : jobTarget;
}
