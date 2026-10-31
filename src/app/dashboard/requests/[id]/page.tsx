"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { createClient } from "@/lib/supabase/client";
import { formatAr } from "@/lib/arabicDigits";
import { dayLabel } from "@/lib/dayLabel";
import { pointsAr } from "@/lib/pointsFormat";
import { REQUEST_STATUS_LABEL_AR, resolveRequestKind } from "@/lib/jobs/requestStatus";
import { isSafeRequestId, readRequestFacts, type RequestFacts } from "@/lib/requests/facts";
import { openJobHref } from "@/lib/requestLinks";
import AgentMissionCard from "@/components/mission/AgentMissionCard";
import { Skeleton } from "@/components/ui";

/**
 * A REQUEST'S OWN PAGE («التفاصيل»). It opens at once: the title, the state, the date, what was delivered and the points come from the row the customer pressed (no wait), or are skeleton lines when the
 * page was opened by its address. Then, in parallel, the job and the mission are read (two small reads); only after that does the heavy part mount: the mission card with its steps, result lines and files, and
 * the link to the conversation. The chat is a separate button here, never what «التفاصيل» opens.
 */
interface Loaded {
  title: string | null;
  stateAr: string;
  createdAt: string;
  delivered: number | null;
  requested: number | null;
  pointsAr: string | null;
  missionId: string | null;
  jobId: string | null;
}

const fromFacts = (f: RequestFacts | null): Partial<Loaded> | null => (f ? { title: f.title, stateAr: f.stateAr, createdAt: f.createdAt, delivered: f.delivered, requested: f.requested, pointsAr: f.pointsAr } : null);

export default function RequestDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useUser();
  const router = useRouter();
  const safe = isSafeRequestId(id);
  const [facts, setFacts] = useState<Partial<Loaded> | null>(() => (typeof window === "undefined" ? null : fromFacts(readRequestFacts(id))));
  const [missionId, setMissionId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [read, setRead] = useState<"loading" | "done" | "missing" | "failed">("loading");

  // the head start of the list's row (read once on the client, after the first paint, so the server and the browser agree)
  useEffect(() => { if (!facts) setFacts(fromFacts(readRequestFacts(id))); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  // ONE round of two parallel reads: the job (if the id is a job) and the mission (if the id is a mission, or the one that made this job)
  useEffect(() => {
    if (!user || !safe) { if (!safe) setRead("missing"); return; }
    let alive = true;
    (async () => {
      try {
        const supabase = createClient();
        const [jobRes, missionRes] = await Promise.all([
          supabase.from("jobs").select("id, status, delivered_units, target_volume_max, charged_credits, reserved_credits, created_at").eq("user_id", user.id).eq("id", id).maybeSingle(),
          supabase.from("missions").select("id, job_id, status, delivered_units, charged_points, reserved_points, created_at, request_text").eq("user_id", user.id).or(`id.eq.${id},job_id.eq.${id}`).limit(1).maybeSingle(),
        ]);
        if (!alive) return;
        const job: any = jobRes.data;
        const mission: any = missionRes.data;
        if (!job && !mission) { setRead(jobRes.error || missionRes.error ? "failed" : "missing"); return; }
        if (mission?.id) setMissionId(String(mission.id));
        setJobId(job?.id ?? mission?.job_id ?? null);
        const kind = job ? resolveRequestKind({ status: job.status, delivered: job.delivered_units, requested: job.target_volume_max }) : null;
        const charged = job?.charged_credits ?? mission?.charged_points;
        setFacts((prev) => ({
          ...prev,
          title: prev?.title ?? (typeof mission?.request_text === "string" ? mission.request_text : null),
          stateAr: prev?.stateAr || (kind ? REQUEST_STATUS_LABEL_AR[kind] : "قيد التنفيذ"),
          createdAt: job?.created_at ?? mission?.created_at ?? prev?.createdAt,
          delivered: typeof (job?.delivered_units ?? mission?.delivered_units) === "number" ? Number(job?.delivered_units ?? mission?.delivered_units) : prev?.delivered ?? null,
          requested: typeof job?.target_volume_max === "number" ? job.target_volume_max : prev?.requested ?? null,
          pointsAr: charged !== undefined && charged !== null ? pointsAr(Number(charged)) : prev?.pointsAr ?? null,
        }));
        setRead("done");
      } catch { if (alive) setRead("failed"); }
    })();
    return () => { alive = false; };
  }, [user, id, safe]);

  // the link to the conversation is resolved last (it is only for the «افتح المحادثة» button)
  useEffect(() => {
    if (read !== "done" || !jobId) return;
    let alive = true;
    fetch(`/api/jobs/${encodeURIComponent(jobId)}/conversation`, { cache: "no-store" }).then((r) => r.json()).then((j) => { if (alive && j?.success && typeof j.conversationId === "string") setConversationId(j.conversationId); }).catch(() => {});
    return () => { alive = false; };
  }, [read, jobId]);

  const known = facts !== null;
  return (
    <div data-screen-label="RequestDetails" className="flex-1">
      <div className="mx-auto flex max-w-[820px] flex-col gap-4 px-4 pb-16 pt-[22px]">
        <Link href="/dashboard/requests" data-testid="details-back" className="inline-flex min-h-11 w-fit items-center rounded-full bg-sf2 px-4 text-[13px] text-ink no-underline">→ طلباتي</Link>

        <header className="flex flex-col gap-2" data-testid="details-head">
          {facts?.title ? <h1 data-testid="details-title" className="m-0 break-words font-display text-[24px] font-medium leading-[1.5] text-ink sm:text-[28px]">{facts.title}</h1> : <Skeleton className="h-8 w-4/5" />}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-mut" data-testid="details-facts">
            {facts?.stateAr ? <span className="rounded-full bg-sf2 px-3 py-0.5 text-[12px] font-medium text-ink" data-testid="details-state">{facts.stateAr}</span> : <Skeleton className="h-6 w-20" />}
            {facts?.createdAt ? <span>{dayLabel(facts.createdAt)}</span> : <Skeleton className="h-5 w-24" />}
            {facts && facts.delivered !== null && facts.delivered !== undefined ? <span data-testid="details-delivered">{facts.delivered !== undefined ? `وصل ${formatAr(facts.delivered)}${facts.requested ? ` من ${formatAr(facts.requested)}` : ""}` : ""}</span> : known ? null : <Skeleton className="h-5 w-28" />}
            {facts?.pointsAr ? <span data-testid="details-points">{facts.pointsAr}</span> : known ? null : <Skeleton className="h-5 w-16" />}
          </div>
        </header>

        {read === "missing" ? <p role="alert" data-testid="details-missing" className="m-0 rounded-[18px] border border-ln bg-sf p-4 text-sm text-ink">لم نجد هذا الطلب في حسابك. ارجع إلى «طلباتي» وافتحه من هناك.</p> : null}
        {read === "failed" ? <p role="alert" className="m-0 rounded-[18px] border border-ln bg-sf p-4 text-sm text-ink">تعذّر تحميل تفاصيل الطلب الآن. تحقق من الاتصال ثم حاول مرة أخرى.</p> : null}

        {/* THE HEAVY PART, after the facts: the mission's own card (steps, result lines, files); a skeleton while the two reads are on their way */}
        {read === "loading" ? <div data-testid="details-skeleton" role="status" aria-label="جاري تحميل تفاصيل الطلب" className="flex flex-col gap-2"><Skeleton className="h-24 w-full" /><Skeleton className="h-16 w-full" /></div> : null}
        {read === "done" && missionId ? <AgentMissionCard missionId={missionId} /> : null}
        {read === "done" && !missionId ? <p className="m-0 text-[13px] leading-[1.9] text-ink2" data-testid="details-no-mission">هذا طلب من النوع القديم: ملفاته في «طلباتي» ونتيجته في المحادثة.</p> : null}

        {read === "done" ? (
          <div className="flex flex-wrap gap-2">
            {conversationId || jobId ? <button type="button" data-testid="details-open-chat" onClick={() => router.push(openJobHref({ jobId: jobId ?? id, conversationId }))} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-5 text-[13px] text-ink">افتح المحادثة</button> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
