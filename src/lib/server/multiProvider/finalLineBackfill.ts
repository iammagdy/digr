import { checkCustomerText } from "@/lib/agentMission/text";
import { toArabicDigits } from "@/lib/arabicDigits";
import { NEUTRAL_STOP_REASON_AR } from "@/lib/multiProvider/copy";
import { isGroupQuoteItems } from "./jobGroupPlan";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function backfillChainFinalLines(admin: any, opts: { nowMs: number }) {
  const since = new Date(opts.nowMs - 7 * DAY_MS).toISOString();
  const { data: jobs, error } = await admin.from("jobs").select("id,user_id,quote_id,delivered_units,target_volume_max,created_at,status,capability_slug")
    .eq("status", "completed").gte("created_at", since).order("created_at", { ascending: false }).limit(300);
  if (error || !Array.isArray(jobs)) return { considered: 0, written: 0 };
  let written = 0;
  for (const job of jobs) {
    try {
      const { data: events } = await admin.from("job_events").select("message").eq("job_id", job.id);
      if ((events || []).some((event: any) => typeof event.message === "string" && event.message.startsWith("المسلَّم "))) continue;
      const { data: quote } = await admin.from("plans_quotes").select("items").eq("id", job.quote_id).maybeSingle();
      if (isGroupQuoteItems(quote?.items)) continue;
      const x = Number(job.delivered_units) || 0, n = Number(job.target_volume_max) || 0;
      const count = `المسلَّم ${toArabicDigits(x)} من ${toArabicDigits(n)} مطلوب.`;
      const stored = await admin.storage.from("partials").download(`final_line/${job.id}.json`);
      const parsed = !stored.error && stored.data ? JSON.parse(await stored.data.text()) : null;
      const valid = parsed?.v === 1 && parsed.deliveredUnits === x && parsed.targetMax === n && typeof parsed.messageAr === "string" && parsed.messageAr.startsWith(count) && checkCustomerText(parsed.messageAr).issues.length === 0;
      const message = valid ? parsed.messageAr : x < n ? `${count} ${NEUTRAL_STOP_REASON_AR}` : count;
      await admin.from("job_events").insert({ job_id: job.id, user_id: job.user_id, message, units: 0, event_type: "info" });
      written++;
    } catch { /* best effort; a later tick retries */ }
  }
  return { considered: jobs.length, written };
}
