"use client";

import { pointsAr } from "@/lib/pointsFormat";
import { normalizeReleaseWording } from "@/lib/releaseWording";
import { pluralizeStoredCountsAr } from "@/lib/planCounts";
import { openJobHref } from "@/lib/requestLinks";
import { isDeterministicFailureAr } from "@/lib/providerFailureText";
import { customerSafeText } from "@/lib/agentMission/text";
import ReportProblemButton from "@/components/ReportProblemButton";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { createClient } from "@/lib/supabase/client";
import { formatAr } from "@/lib/arabicDigits";
import { dayLabel } from "@/lib/dayLabel";
import { JOBS_COLLECTION } from "@/lib/constants";
import { getJobIdForQuote } from "@/lib/md5";
import { startNewResearch } from "@/lib/newResearchNavigation";
import { resultsReleasable } from "@/lib/producedFormats";
import { jobFileIds } from "@/lib/producedFormats";
import { REQUEST_STATUS_LABEL_AR, collectedBeforeStopText, deliveredNothing, partialDeliveryText, resolveRequestKind, type RequestKind } from "@/lib/jobs/requestStatus";
import { customerFacingCapabilityLabel, customerFacingQuoteSummary } from "@/lib/customerFacingRequestLabels";
import { customerFacingConversationTitle } from "@/lib/customerFacingConversationTitle";
import { chunkMarksFromEvents, computeJobProgress } from "@/lib/jobProgress";
import { STALLED_LINE_AR, isJobStalled } from "@/lib/jobStall";
import { closePageLineAr } from "@/lib/driverMode";
import MissionPlanInline from "@/components/mission/MissionPlanInline";
import OpenMissionsList from "@/components/mission/OpenMissionsList";
import { MODEL_PLAN_SLUG } from "@/lib/modelPlanner/constants";
import { useDriverMode } from "@/hooks/useDriverMode";
import { deliveredOfAr, itemNounOfPlan, knownItemNoun } from "@/lib/agentMission/itemNoun";
import { moneyLineAr } from "@/lib/agentMission/moneyText";
import { REQUESTS_PAGE_SIZE, hashOfTab, tabFromHash, tabOfKind, type RequestTab } from "@/lib/requests/tabs";
import { customerFormatsOf } from "@/lib/requests/files";
import type { MissionIndexRow, RequestIndex } from "@/lib/requests/types";

interface JobDoc {
  $id: string;
  templateSlug: string;
  params?: string;
  status: string;
  reservedCredits: number;
  chargedCredits?: number;
  rowsCollected?: number;
  /** True when the job row carried a delivered count (an absent count is unknown, never zero). */
  deliveredKnown?: boolean;
  targetVolumeMax?: number;
  errorAr?: string;
  createdAt: string;
  /** From the jobs row, for the live progress and stalled lines of a running request. */
  updatedAt?: string;
  leaseUntil?: string | null;
  nextAttemptAt?: string | null;
  attemptCount?: number;
  fileIds: { xlsx: string | null; pdf: string | null; csv: string | null };
}
interface QuoteInfo { conversationId: string; targetVolumeMax: number; summaryAr?: string }
type Kind = RequestKind;
const kindOfJob = (j: JobDoc): Kind =>
  resolveRequestKind({ status: j.status, delivered: j.rowsCollected, requested: j.targetVolumeMax });

const STATUS: Record<Kind, { label: string; fg: string; tint: string }> = {
  done: { label: REQUEST_STATUS_LABEL_AR.done, fg: "var(--ok)", tint: "var(--ok)" },
  partial: { label: REQUEST_STATUS_LABEL_AR.partial, fg: "var(--gold)", tint: "var(--gold)" },
  running: { label: REQUEST_STATUS_LABEL_AR.running, fg: "var(--gold)", tint: "var(--gold)" },
  refunded: { label: REQUEST_STATUS_LABEL_AR.refunded, fg: "var(--mut)", tint: "var(--mut)" },
};
const TABS: Array<[RequestTab, string]> = [
  ["all", "الكل"],
  ["running", "قيد التنفيذ"],
  ["done", "مكتملة"],
  ["ended", "فشلت أو أُلغيت"],
  ["refunded", "حجز مؤقت مُحرَّر"],
];
/** The chip of a request that never became a job, by how it ended. */
const ENDED_CHIP_AR: Record<string, string> = { cancelled: "أُلغيت", expired: "انتهت صلاحية الخطة", failed: "فشلت", unserved: "لم تُنفَّذ" };
const chunksOf = <T,>(items: T[], size: number): T[][] => { const out: T[][] = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; };

function targetOf(params?: string): string {
  try {
    const p = JSON.parse(params || "{}");
    if (p.username) return `بيانات حساب @${String(p.username).replace(/^@/, "")}`;
    if (p.query) return String(p.query);
  } catch { /* fall through */ }
  return "طلب بحث";
}

/** What a request card says about a request that did not run: always «حجز مؤقت مُحرَّر», never «أُعيد / استرداد / إرجاع». */
function formatRefundedNote(rawError?: string, reservedCredits = 0): string {
  const released = `حجز مؤقت مُحرَّر: ${pointsAr(reservedCredits)} كاملة، ولم يُخصم منك شيء.`;
  if (!rawError) {
    return `لم تتوفر سجلات كافية — ${released}`;
  }
  let cleaned = rawError
    .replace(/مراقب\s*المهام\s*\(?Watchdog\)?/gi, "")
    .replace(/watchdog/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (/cannot settle|chunk lease|job_quote_|settle_job|provider|endpoint|\bUSD\b|supabase|stack trace|internal error/i.test(cleaned)) {
    return `تعذر إكمال البحث — ${released}`;
  }

  if (
    cleaned.includes("لتجاوز المهلة الزمنية") ||
    cleaned.includes("لتأخر التنفيذ") ||
    cleaned.includes("تلقائياً")
  ) {
    cleaned = "تم إلغاء الطلب تلقائياً لتأخر التنفيذ، وهو حجز مؤقت مُحرَّر كاملًا ولم يُخصم منك شيء.";
  }

  // the render-time guard: an English or internal phrase stored with an older request (a release reason written by the system) is shown as its Arabic meaning, never as it was stored
  cleaned = customerSafeText(cleaned, "تعذر إكمال البحث");
  cleaned = normalizeReleaseWording(cleaned);
  if (cleaned.includes("حجز مؤقت مُحرَّر")) return cleaned;

  return `${cleaned} — ${released}`;
}

const DL_ICON = "M12 4v11M7 10l5 5 5-5M5 20h14";

export default function RequestsPage() {
  const { user } = useUser();
  const router = useRouter();
  const driverMode = useDriverMode();
  const [jobs, setJobs] = useState<JobDoc[]>([]);
  const [quotes, setQuotes] = useState<Record<string, QuoteInfo>>({});
  const [nounByJob, setNounByJob] = useState<Record<string, string>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // the selected tab lives in the address (`#running`), so a reload keeps it; null until the address was read
  const [tab, setTab] = useState<RequestTab | null>(null);
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [limit, setLimit] = useState(REQUESTS_PAGE_SIZE);
  const [index, setIndex] = useState<RequestIndex | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState("");
  const [progressByJob, setProgressByJob] = useState<Record<string, string>>({});
  const [dl, setDl] = useState<string | null>(null);
  const [dlError, setDlError] = useState("");
  const loadSeq = useRef(0);

  useEffect(() => {
    const read = () => { setTab(tabFromHash(window.location.hash)); setLimit(REQUESTS_PAGE_SIZE); };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const searchedRef = useRef("");
  useEffect(() => {
    const t = setTimeout(() => {
      const next = query.trim();
      if (next === searchedRef.current) return;
      searchedRef.current = next;
      setLoading(true);
      setLimit(REQUESTS_PAGE_SIZE);
      setSearched(next);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  function selectTab(next: RequestTab) {
    setLoading(true);
    setLimit(REQUESTS_PAGE_SIZE);
    setTab(next);
    try { window.history.replaceState(null, "", hashOfTab(next)); } catch { /* the tab still changes */ }
  }

  const load = useCallback(async () => {
    if (!user || tab === null) return;
    const seq = ++loadSeq.current;
    try {
      const supabase = createClient();
      // WHICH requests, in which tab, for which search, how many each tab holds: decided by the server (`/api/requests`); the jobs it lists are then read here for their files and points
      const indexRes = await fetch(`/api/requests?${new URLSearchParams({ tab, q: searched, offset: "0", limit: String(limit) }).toString()}`, { cache: "no-store" });
      const indexJson = await indexRes.json().catch(() => null);
      if (!indexRes.ok || !indexJson?.success) throw new Error("requests_index");
      const listed = indexJson as RequestIndex;
      const jobIds = listed.rows.filter((r) => r.type === "job").map((r) => r.id);
      // reads of the listed ids go in small groups so the address stays short however many pages were loaded
      const inGroups = async (read: (ids: string[]) => PromiseLike<{ data: any[] | null; error: any }>) => {
        const parts = await Promise.all(chunksOf(jobIds, 40).map((ids) => read(ids)));
        return { data: parts.flatMap((p) => p.data || []), error: parts.find((p) => p.error)?.error ?? null };
      };
      const [jobsRes, quotesRes, convRes, msgsRes, missionsRes, planMsgsRes] = await Promise.all([
        inGroups((ids) => supabase.from(JOBS_COLLECTION).select("*").eq("user_id", user.id).in("id", ids)),
        supabase
          .from("plans_quotes")
          .select("id, status, items, total_reserved_credits, created_at")
          .eq("user_id", user.id)
          .eq("status", "accepted")
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("conversations")
          .select("id, title")
          .eq("user_id", user.id)
          .order("updated_at", { ascending: false })
          .limit(100),
        supabase
          .from("messages")
          .select("conversation_id, quote")
          .eq("user_id", user.id)
          .not("quote", "is", null)
          .order("created_at", { ascending: false })
          .limit(100),
        // AGENT missions: the mission names its job; the assistant message that shows its card names the mission and the conversation
        inGroups((ids) => supabase.from("missions").select("id, job_id, stages:plan_public->stages, files").eq("user_id", user.id).in("job_id", ids)),
        supabase
          .from("messages")
          .select("conversation_id, plan")
          .eq("user_id", user.id)
          .eq("role", "assistant")
          .not("plan", "is", null)
          .order("created_at", { ascending: false })
          .limit(300),
      ]);
      if (jobsRes.error) throw jobsRes.error;
      const conversationTitles = new Map<string, string>();
      for (const conversation of convRes.data || []) {
        conversationTitles.set(conversation.id, customerFacingConversationTitle(conversation.title || ""));
      }
      // the files of each listed job: its artifact rows asked for BY JOB (the latest 100 rows of the whole account lose a job's row once the account has more), the file the job stored, and the files an agent mission delivered
      const artifactsRes = jobIds.length > 0
        ? await inGroups((listedJobIds) => supabase.from("artifact_versions").select("job_id, file_id_xlsx, file_id_pdf, file_id_csv, version_number").eq("user_id", user.id).in("job_id", listedJobIds).order("version_number", { ascending: false }))
        : { data: [] as any[] };
      const artifactsByJob = new Map<string, any[]>();
      for (const artifact of (artifactsRes.data || []) as any[]) artifactsByJob.set(artifact.job_id, [...(artifactsByJob.get(artifact.job_id) || []), artifact]);
      const missionFilesByJob = new Map<string, any[]>();
      for (const m of (missionsRes?.data || []) as any[]) if (m.job_id && Array.isArray(m.files)) missionFilesByJob.set(String(m.job_id), m.files);

      const mappedJobs: JobDoc[] = (jobsRes.data || []).map((r: any) => ({
        $id: r.id,
        templateSlug: r.endpoint_id || r.template_slug || r.templateSlug || "",
        params: typeof r.params === "string" ? r.params : JSON.stringify(r.params || {}),
        status: r.status,
        reservedCredits: Number(r.reserved_credits ?? r.reservedCredits ?? 0),
        chargedCredits: r.charged_credits !== undefined && r.charged_credits !== null ? Number(r.charged_credits) : undefined,
        rowsCollected: r.delivered_units ?? r.rows_collected ?? r.rowsCollected ?? 0,
        deliveredKnown: typeof (r.delivered_units ?? r.rows_collected ?? r.rowsCollected) === "number",
        targetVolumeMax: typeof r.target_volume_max === "number" ? r.target_volume_max : undefined,
        errorAr: r.error_message ?? r.error_ar ?? r.errorAr ?? undefined,
        createdAt: r.created_at || r.createdAt || new Date().toISOString(),
        updatedAt: r.updated_at ?? undefined,
        leaseUntil: r.lease_until ?? null,
        nextAttemptAt: r.next_attempt_at ?? null,
        attemptCount: typeof r.attempt_count === "number" ? r.attempt_count : undefined,
        fileIds: jobFileIds({ artifacts: artifactsByJob.get(r.id), resultFileId: r.result_file_id, missionFiles: missionFilesByJob.get(r.id) }),
      }));
      if (seq !== loadSeq.current) return; // a newer tab, search or page was asked for in the meantime
      setIndex(listed);
      setJobs(mappedJobs);
      // Live progress of the running requests, from the page lines their chunks wrote (one read for all of them, recomputed every refresh).
      try {
        const live = mappedJobs.filter((j) => (j.status === "queued" || j.status === "running") && (j.targetVolumeMax || 0) > 0);
        if (live.length > 0) {
          const { data: lines } = await supabase
            .from("job_events")
            .select("job_id, message, units, created_at")
            .in("job_id", live.map((j) => j.$id))
            .eq("event_type", "progress")
            .like("message", "الصفحة%")
            .order("created_at", { ascending: false })
            .limit(live.length * 24);
          const byJob = new Map<string, any[]>();
          for (const line of (lines || []) as any[]) byJob.set(line.job_id, [...(byJob.get(line.job_id) || []), line]);
          const next: Record<string, string> = {};
          for (const j of live) {
            next[j.$id] = computeJobProgress({
              delivered: j.rowsCollected ?? 0,
              target: j.targetVolumeMax as number,
              marks: chunkMarksFromEvents(byJob.get(j.$id) || []),
              startedAt: Date.parse(j.createdAt),
              retrying: Boolean(j.nextAttemptAt && new Date(j.nextAttemptAt).getTime() > Date.now()) || Number(j.attemptCount || 0) > 0,
            }).lineAr;
          }
          setProgressByJob(next);
        } else {
          setProgressByJob({});
        }
      } catch {
        // progress is a courtesy line; the list never fails because of it
      }
      // Map quoteId to conversationId and summaryAr from messages table
      const quoteToConv: Record<string, { conversationId: string; summaryAr?: string }> = {};
      for (const m of (msgsRes?.data || []) as any[]) {
        const qId = m.quote?.quoteId || m.quote?.id;
        if (qId && m.conversation_id) {
          quoteToConv[qId] = {
            conversationId: m.conversation_id,
            summaryAr: m.quote?.summaryAr || m.quote?.summary_ar,
          };
        }
      }

      const qMap: Record<string, QuoteInfo> = {};
      for (const q of (quotesRes?.data || []) as any[]) {
        const jId = getJobIdForQuote(q.id);
        const item = Array.isArray(q.items) ? q.items[0] : null;
        const msgInfo = quoteToConv[q.id];
        qMap[jId] = {
          conversationId: msgInfo?.conversationId || "",
          targetVolumeMax: item?.targetVolumeMax ?? item?.target_volume_max ?? 0,
          summaryAr: msgInfo?.summaryAr || (typeof item?.summaryAr === "string" && item.summaryAr.trim() ? item.summaryAr.trim() : customerFacingQuoteSummary(item?.capabilitySlug)),
        };
      }
      // an AGENT mission's request opens in the conversation that holds its card: job -> mission -> the message whose plan names the mission
      const conversationOfMission = new Map<string, string>();
      for (const m of (planMsgsRes?.data || []) as any[]) {
        const missionId = m?.plan?.agentMissionId;
        if (typeof missionId === "string" && m.conversation_id && !conversationOfMission.has(missionId)) conversationOfMission.set(missionId, m.conversation_id);
      }
      // an AGENT mission names its items by the noun of its request («تغريدات»), never «سجلات»
      const nounMap: Record<string, string> = {};
      for (const m of (missionsRes?.data || []) as any[]) {
        if (m.job_id && Array.isArray(m.stages)) nounMap[String(m.job_id)] = itemNounOfPlan({ stages: m.stages }).singular;
        const conversationId = conversationOfMission.get(String(m.id));
        if (m.job_id && conversationId) qMap[String(m.job_id)] = { ...(qMap[String(m.job_id)] ?? { targetVolumeMax: 0 }), conversationId };
      }
      setQuotes(qMap);
      setNounByJob(nounMap);

      const tMap: Record<string, string> = {};
      for (const c of (convRes.data || []) as any[]) {
        tMap[c.id || c.$id] = c.title;
      }
      setTitles(tMap);
      setFailed(false);
    } catch {
      if (seq === loadSeq.current) setFailed(true);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [user, tab, searched, limit]);

  const jobStatusesKey = jobs.map((job) => `${job.$id}:${job.status}`).join("|");
  useEffect(() => {
    void load();
    let ticks = 0;
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      ticks += 1;
      const activeJobs = jobs.filter((j) => j.status === "queued" || j.status === "running");
      // Running requests refresh every 4 seconds; otherwise the list still refreshes every 16 seconds so a
      // request started elsewhere (another tab, the chat) appears without a manual reload.
      if (activeJobs.length > 0) {
        void load();
        // Background progression support: nudge active jobs so they never stall even if chat tab is closed
        activeJobs.forEach((aj) => {
          void fetch(`/api/jobs/${aj.$id}/nudge`, { method: "POST" }).catch(() => {});
        });
      } else if (ticks % 4 === 0) {
        void load();
      }
    }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, jobStatusesKey]);

  // The list is the server's: its tab counts are exactly what each tab lists, and the rows come newest first.
  const counts = index?.counts ?? { all: 0, running: 0, done: 0, ended: 0, refunded: 0 };
  const jobById = new Map(jobs.map((j) => [j.$id, j] as const));
  const shownRows = (index?.rows ?? []).filter((r) => r.type === "mission" || jobById.has(r.id));

  /** «إلغاء» on a question or a plan that waits for the customer: ends the request (nothing is held before approval) and reloads the page's list. */
  async function cancelPending(id: string) {
    setBusyId(id);
    setCancelError("");
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setCancelError(typeof json?.error === "string" && /[\u0600-\u06FF]/.test(json.error) ? json.error : "تعذّر إلغاء المهمة الآن. حاول بعد قليل.");
      }
    } catch { setCancelError("تعذّر إلغاء المهمة الآن. حاول بعد قليل."); }
    setBusyId(null);
    await load();
  }

  async function download(job: JobDoc, ext: "xlsx" | "pdf" | "csv") {
    const key = `${job.$id}_${ext}`;
    setDl(key);
    setDlError("");
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const headers: Record<string, string> = {};
      if (session?.access_token) {
        headers["Authorization"] = `Bearer ${session.access_token}`;
      }
      const res = await fetch(`/api/jobs/${job.$id}/download?format=${ext}`, { headers });
      if (!res.ok) throw new Error(String(res.status));
      const payload = await res.json();
      if (!payload?.success || !payload?.signedUrl) throw new Error("no_signed_url");

      let blobUrl: string | null = null;
      try {
        const fileRes = await fetch(payload.signedUrl);
        if (fileRes.ok) {
          blobUrl = URL.createObjectURL(await fileRes.blob());
        }
      } catch {
        // Fall back to direct signed URL navigation
      }

      if (blobUrl) {
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = payload.downloadFileName || `diger_data_${job.$id.slice(0, 8)}.${ext}`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(blobUrl!); a.remove(); }, 30000);
      } else {
        window.location.assign(payload.signedUrl);
      }
    } catch {
      setDlError("تعذّر تحميل الملف. يرجى إعادة المحاولة. (التحميل متاح لمدة ٩٠ يومًا)");
    } finally {
      setDl(null);
    }
  }

  const openFile = async (job: JobDoc, retry = false) => {
    // A request the source refused for its own content fails the same way again: it is opened, never re-quoted.
    retry = retry && !isDeterministicFailureAr(job.errorAr);
    try {
      sessionStorage.setItem("diger_active_job_id", job.$id);
      sessionStorage.setItem("diger_canvas_open", "1");
    } catch {
      // Non-blocking storage fallback
    }
    // a request opens in ITS conversation (its card and its files), never in a new empty chat: when the list could not link it (an older request, or one beyond the recent messages), the server resolves it for this one request
    let conversationId = quotes[job.$id]?.conversationId || "";
    if (!conversationId) {
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(job.$id)}/conversation`, { cache: "no-store" });
        const json = await res.json().catch(() => null);
        if (json?.success && typeof json.conversationId === "string") conversationId = json.conversationId;
      } catch {
        // the request still opens by its job
      }
    }
    router.push(openJobHref({ jobId: job.$id, conversationId, retry }));
  };

  /** One request that never became a job (queued, being planned, cancelled, expired, failed before approval): everything its row shows came with the list. */
  function missionRow(r: MissionIndexRow) {
    const chip = r.tab === "running" ? REQUEST_STATUS_LABEL_AR.running : ENDED_CHIP_AR[r.endedKind ?? "cancelled"] ?? "أُلغيت";
    const tint = r.tab === "running" ? "var(--gold)" : "var(--mut)";
    return (
      <article key={`m_${r.id}`} data-testid="request-row" data-kind={r.tab} className="flex flex-col gap-1.5 rounded-2xl border border-ln bg-sf px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <p data-testid="request-mission-title" className="m-0 min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{r.title || "طلب بدون نص"}</p>
          <span className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: `color-mix(in oklab, ${tint} 13%, transparent)`, color: tint }}>{chip}</span>
        </div>
        <p className="m-0 text-xs text-mut">{dayLabel(r.createdAt)}{r.tab === "ended" ? ` · ${pointsAr(0)}` : ""}</p>
        <p className="m-0 line-clamp-2 text-xs leading-[1.7] text-ink2">{r.noteAr}</p>
        {r.conversationId && (
          <div className="flex gap-2">
            <a href={`/dashboard/chat?c=${encodeURIComponent(r.conversationId)}`} className="flex min-h-11 items-center rounded-full bg-sf2 px-4 text-xs font-medium text-ink">التفاصيل</a>
          </div>
        )}
      </article>
    );
  }

  const searching = searched.length > 0;
  const loadedCount = shownRows.length;
  const tabTotal = tab === "all" ? Math.max(0, counts.all - (index?.pending.length ?? 0)) : counts[tab ?? "all"];

  return (
    <div data-screen-label="Requests" className="flex-1">
      <div className="mx-auto flex max-w-[820px] flex-col gap-3 px-4 pb-16 pt-[22px]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="m-0 font-display text-[32px] font-medium leading-[1.1] text-ink sm:text-[40px]">طلباتي</h1>
            <p className="mb-0 mt-1.5 text-sm font-light text-mut">كل أبحاثك وملفاتها في مكان واحد — التحميل متاح لمدة ٩٠ يومًا.</p>
          </div>
          <button type="button" onClick={() => startNewResearch(() => router.push("/dashboard/chat"))} className="min-h-11 cursor-pointer whitespace-nowrap rounded-full border-0 bg-ac px-[18px] text-[13px] text-onac">+ سؤال بحثي جديد</button>
        </div>

        <div className="flex max-w-full flex-wrap gap-1 self-start rounded-3xl bg-sf2 p-1" role="tablist">
          {TABS.map(([id, label]) => {
            const on = tab === id;
            return (
              <button
                key={id} type="button" role="tab" aria-selected={on} data-testid={`request-tab-${id}`} onClick={() => selectTab(id)}
                className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-full border-0 px-3 text-[13px] font-medium"
                style={{ background: on ? "var(--sf)" : "transparent", color: on ? "var(--ink)" : "var(--mut)", boxShadow: on ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}
              >
                {label} <span className="opacity-60" data-testid={`request-count-${id}`}>{index ? formatAr(counts[id]) : "…"}</span>
              </button>
            );
          })}
        </div>

        <input
          type="search" dir="rtl" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={80}
          placeholder="ابحث في نص طلباتك" aria-label="ابحث في نص طلباتك" data-testid="requests-search"
          className="min-h-11 w-full rounded-full border border-ln bg-sf px-4 text-[14px] text-ink placeholder:text-fnt"
        />

        {tab === "all" && <OpenMissionsList items={index?.pending ?? []} busyId={busyId} error={cancelError} onCancel={(id) => void cancelPending(id)} />}

        {failed && <p role="alert" className="m-0 text-[13px] text-bad">تعذّر تحميل طلباتك الآن. تحقق من الاتصال ثم حاول مرة أخرى.</p>}
        {dlError && <p role="alert" className="m-0 text-[13px] text-bad">{dlError}</p>}
        {loading && [0, 1, 2].map((i) => <div key={i} className="h-20 rounded-2xl bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />)}

        {!loading && shownRows.map((row) => {
          if (row.type === "mission") return missionRow(row);
          const j = jobById.get(row.id)!;
          const k = kindOfJob(j);
          const st = STATUS[k];
          const q = quotes[j.$id];
          // the words of the request itself (an agent request), else a title stored before the plural rule says «٥ سجل»: it is read again at display time, the stored row stays as it is.
          const title = pluralizeStoredCountsAr(row.title || (q?.conversationId && titles[q.conversationId]) || (q?.summaryAr ? customerSafeText(q.summaryAr, "") : "") || targetOf(j.params) || `طلب ${customerFacingCapabilityLabel(j.templateSlug)}`);
          const requested = j.targetVolumeMax || q?.targetVolumeMax;
          const rows = j.rowsCollected ?? 0;
          // A finished request that delivered no record has no data file to offer: zero files, said once (the same rule as the results panel).
          // A request that did not settle and charge offers no file either, whatever it saved before settlement (resultsReleasable).
          const nothingDelivered = deliveredNothing({ kind: k, delivered: rows, deliveredKnown: j.deliveredKnown }) || !resultsReleasable({ status: j.status, charged_credits: j.chargedCredits });
          const pct = requested ? Math.min(100, (rows / requested) * 100) : 0;
          const stalled = k === "running" && isJobStalled({ status: j.status, updated_at: j.updatedAt ?? j.createdAt, lease_until: j.leaseUntil }, Date.now());
          // an agent mission says «تغريدات» / «تعليقات» / «شركات» (the noun of its request) where the older requests say «السجلات»
          const agentNoun = nounByJob[j.$id] ? knownItemNoun(nounByJob[j.$id]) : null;
          // the same one line as the completion panel, the notification, the e-mail and the wallet: what was charged and for how many items
          const agentMoneyLine = agentNoun ? moneyLineAr({ reservedPoints: j.reservedCredits || 0, chargedPoints: j.chargedCredits ?? 0, delivered: rows, noun: agentNoun }) : "";
          const note = k === "running" ? `جارٍ الجمع — ${closePageLineAr(driverMode)}`
            : k === "refunded" ? `${formatRefundedNote(j.errorAr, j.reservedCredits || 0)}${rows > 0 && requested ? ` ${collectedBeforeStopText(rows, requested)}` : ""}`
            : nothingDelivered ? (agentNoun ? "لم يُسلَّم أي شيء، لذلك لا توجد ملفات لهذا الطلب، ولم يُخصم منك أي رصيد." : "لم يصل أي سجل، لذلك لا توجد ملفات بيانات لهذا الطلب، ولم يُخصم منك أي رصيد.")
            : k === "partial" ? (agentNoun ? `تم تسليم ${deliveredOfAr(rows, requested || rows, agentNoun)}؛ ${agentMoneyLine}.` : partialDeliveryText(rows, requested || rows))
            : k === "done" && agentNoun ? `${agentMoneyLine}.` : "";
          const availableFormats = nothingDelivered ? [] : (["xlsx", "pdf", "csv"] as const).filter(
            (ext) => Boolean(j.fileIds[ext]),
          );
          // the customer's one file is the Excel (the CSV copy is still produced and stored: settlement records it and the close-out reads it)
          const customerFormats = customerFormatsOf(availableFormats);
          const hasFiles = customerFormats.length > 0;
          return (
            <article key={j.$id} data-testid="request-row" data-kind={tabOfKind(k)} className="flex flex-col gap-1.5 rounded-2xl border border-ln bg-sf px-3.5 py-3" style={{ animation: "up .35s both" }}>
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  data-testid="request-title"
                  // Opening a request only shows it; a retry is the «إعادة المحاولة» button below, never a tap on the title.
                  onClick={() => openFile(j)}
                  className="m-0 min-w-0 flex-1 cursor-pointer truncate border-0 bg-transparent p-0 text-right text-[14px] font-medium text-ink hover:underline focus-visible:outline-2"
                >
                  {title}
                </button>
                <span className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: `color-mix(in oklab, ${st.tint} 13%, transparent)`, color: st.fg }}>{k === "refunded" ? "حجز مؤقت مُحرَّر" : st.label}</span>
              </div>
              <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-mut">
                <span>{dayLabel(j.createdAt)}</span>
                <span>{agentNoun ? agentNoun.plural : "السجلات"} <strong className="font-semibold text-ink">{formatAr(rows)}{requested ? ` / ${formatAr(requested)}` : ""}</strong></span>
                <span>{k === "running" ? "محجوز" : pointsAr(j.chargedCredits ?? 0)}</span>
              </p>
              {k === "running" && <div className="h-1 overflow-hidden rounded bg-sf2"><div className="h-full bg-gold" style={{ width: `${pct}%` }} /></div>}
              {k === "running" && progressByJob[j.$id] && <p className="m-0 text-[13px] leading-[1.8] text-ink2" data-testid="request-progress">{progressByJob[j.$id]}</p>}
              {stalled && <p role="status" className="m-0 text-[13px] font-medium leading-[1.8] text-ink" data-testid="request-stalled">{STALLED_LINE_AR}</p>}
              {note && <p className="m-0 line-clamp-2 text-xs leading-[1.7] text-ink2">{pluralizeStoredCountsAr(note)}</p>}
              {(k === "refunded" || k === "partial") && <ReportProblemButton jobId={j.$id} className="self-start" />}
              {j.templateSlug === MODEL_PLAN_SLUG && k === "running" && <MissionPlanInline jobId={j.$id} live={k === "running"} />}
              <div className="flex flex-wrap gap-2">
                {customerFormats.map((ext) => (
                  <button
                    key={ext} type="button" onClick={() => download(j, ext)} disabled={dl === `${j.$id}_${ext}`}
                    className="flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border border-ln2 bg-transparent px-3.5 text-xs text-ink disabled:opacity-60"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={DL_ICON} /></svg>
                    {ext === "xlsx" ? "إكسل" : ext === "pdf" ? "بي دي إف" : "سي إس في"}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => openFile(j, k === "refunded")}
                  className={`min-h-11 cursor-pointer rounded-full border-0 px-4 text-xs font-medium transition-colors ${
                    k === "running" ? "bg-ac text-onac hover:opacity-90" : "bg-sf2 text-ink hover:bg-sf"
                  }`}
                >
                  {k === "running" ? "متابعة التقدم" : k === "refunded" && !isDeterministicFailureAr(j.errorAr) ? "إعادة المحاولة" : "التفاصيل"}
                </button>
              </div>
            </article>
          );
        })}

        {!loading && index?.hasMore && (
          <div className="flex flex-col items-center gap-1.5">
            <p className="m-0 text-xs text-mut" data-testid="requests-shown">يظهر {formatAr(loadedCount)} من {formatAr(tabTotal)}</p>
            <button type="button" data-testid="load-more" onClick={() => setLimit((l) => l + REQUESTS_PAGE_SIZE)} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-6 text-[13px] font-medium text-ink">تحميل المزيد</button>
          </div>
        )}

        {!loading && !failed && shownRows.length === 0 && (index?.pending.length ?? 0) === 0 && searching && (
          <p data-testid="requests-no-match" className="m-0 rounded-3xl border border-dashed border-ln2 px-5 py-8 text-center text-[13px] leading-[1.8] text-mut">لا توجد طلبات تطابق بحثك في هذا القسم.</p>
        )}
        {!loading && !failed && shownRows.length === 0 && (index?.pending.length ?? 0) === 0 && !searching && (
          <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-ln2 px-5 py-10 text-center">
            <span className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-sf2 text-mut">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
            </span>
            <p className="m-0 text-base font-medium text-ink">لا توجد أبحاث هنا بعد</p>
            <p className="m-0 max-w-[340px] text-[13px] font-light leading-[1.8] text-mut">ابدأ بسؤال واحد، وستجد ملفاتك هنا جاهزة للتحميل في أي وقت.</p>
            <button type="button" onClick={() => router.push("/dashboard/chat")} className="mt-1 min-h-11 cursor-pointer rounded-full border-0 bg-ac px-5 text-[13px] text-onac">ابدأ أول بحث</button>
          </div>
        )}
      </div>
    </div>
  );
}
