/**
 * The check the worker makes, on the job row read back from the database, before it settles: the job must still be running (the worker holds it), its
 * collection must be marked complete, and the delivered count on the row must be the count the worker itself recorded. A row that says anything else
 * (for example `queued`, after a start failure was recorded for a job that had in fact started) is not settled: the worker releases the hold instead.
 */
export function collectionCompleteBeforeSettlement(
  row: { status?: unknown; current_cursor?: unknown; delivered_units?: unknown } | null | undefined,
  readError: unknown,
  recordedDeliveredUnits: number,
): boolean {
  return !readError
    && row?.status === "running"
    && row?.current_cursor === "completed"
    && Number(row?.delivered_units || 0) === Number(recordedDeliveredUnits);
}
