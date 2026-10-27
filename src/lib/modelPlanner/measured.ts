/**
 * MEASURED cost of a ROUTED endpoint (a wrapper whose catalog price is a range because any sibling may serve the call): the average of what its calls really cost, from the
 * database: successful calls of jobs on that endpoint (provider_costs, joined through jobs.endpoint_id) and the successful exploration calls (exploration_calls). With fewer than
 * MIN_OBSERVATIONS such calls there is no measurement, and the price stays the HIGHEST sibling price. Never throws.
 */
export const MIN_OBSERVATIONS = 3;

export async function loadMeasuredAvgCallUsd(client: any, endpointId: string): Promise<number | null> {
  if (typeof client?.from !== "function") return null;
  const costs: number[] = [];
  try {
    const { data } = await client.from("exploration_calls").select("cost_usd,http_status,rows_returned").eq("endpoint_id", endpointId).gt("cost_usd", 0).order("created_at", { ascending: false }).limit(50);
    for (const r of Array.isArray(data) ? data : []) if (Number(r.http_status) === 200 && Number(r.rows_returned ?? 1) > 0) costs.push(Number(r.cost_usd));
  } catch { /* the table is not there */ }
  try {
    const jobs = await client.from("jobs").select("id").eq("endpoint_id", endpointId).order("created_at", { ascending: false }).limit(30);
    const ids = (Array.isArray(jobs?.data) ? jobs.data : []).map((j: any) => String(j.id)).filter(Boolean);
    if (ids.length > 0) {
      const { data } = await client.from("provider_costs").select("cost_usd,status,units").in("job_id", ids).eq("status", "success").gt("cost_usd", 0).limit(200);
      for (const r of Array.isArray(data) ? data : []) costs.push(Number(r.cost_usd));
    }
  } catch { /* no measurement */ }
  const good = costs.filter((c) => Number.isFinite(c) && c > 0);
  if (good.length < MIN_OBSERVATIONS) return null;
  return Number((good.reduce((a, b) => a + b, 0) / good.length).toFixed(6));
}
