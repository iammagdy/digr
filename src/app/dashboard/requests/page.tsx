"use client";

import { pointsAr } from "@/lib/pointsFormat";
import { normalizeReleaseWording } from "@/lib/releaseWording";
import { pluralizeStoredCountsAr } from "@/lib/planCounts";
import { openJobHref } from "@/lib/requestLinks";
import { isDeterministicFailureAr } from "@/lib/providerFailureText";
import ReportProblemButton from "@/components/ReportProblemButton";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { createClient } from "@/lib/supabase/client";
import { formatAr } from "@/lib/arabicDigits";
import { dayLabel } from "@/lib/dayLabel";
import { JOBS_COLLECTION } from "@/lib/constants";
import { getJobIdForQuote } from "@/lib/md5";
import { startNewResearch } from "@/lib/newResearchNavigation";
import { resultsReleasable } from "@/lib/producedFormats";
import { REQUEST_STATUS_LABEL_AR, collectedBeforeStopText, deliveredNothing, partialDeliveryText, resolveRequestKind, type RequestKind } from "@/lib/jobs/requestStatus";
import { customerFacingCapabilityLabel, customerFacingQuoteSummary } from "@/lib/customerFacingRequestLabels";
import { customerFacingConversationTitle } from "@/lib/customerFacingConversationTitle";
import { chunkMarksFromEvents, computeJobProgress } from "@/lib/jobProgress";
import { STALLED_LINE_AR, isJobStalled } from "@/lib/jobStall";
import { closePageLineAr } from "@/lib/driverMode";
import { useDriverMode } from "@/hooks/useDriverMode";

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
const kindOfTab = (k: Kind): "done" | "running" | "refunded" => (k === "partial" ? "done" : k);

const STATUS: Record<Kind, { label: string; fg: string; tint: string }> = {
  done: { label: REQUEST_STATUS_LABEL_AR.done, fg: "var(--ok)", tint: "var(--ok)" },
  partial: { label: REQUEST_STATUS_LABEL_AR.partial, fg: "var(--gold)", tint: "var(--gold)" },
  running: { label: REQUEST_STATUS_LABEL_AR.running, fg: "var(--gold)", tint: "var(--gold)" },
  refunded: { label: REQUEST_STATUS_LABEL_AR.refunded, fg: "var(--mut)", tint: "var(--mut)" },
};
const TABS: Array<["all" | "done" | "running" | "refunded", string]> = [
  ["all", "الكل"],
  ["done", "مكتملة"],
  ["running", "قيد التنفيذ"],
  ["refunded", "حجز مؤقت مُحرَّر"],
];

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
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<"all" | Kind>("all");
  const [progressByJob, setProgressByJob] = useState<Record<string, string>>({});
  const [dl, setDl] = useState<string | null>(null);
  const [dlError, setDlError] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const supabase = createClient();
      const [jobsRes, quotesRes, convRes, msgsRes, artifactsRes] = await Promise.all([
        supabase
          .from(JOBS_COLLECTION)
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100),
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
        supabase
          .from("artifact_versions")
          .select("job_id, file_id_xlsx, file_id_pdf, file_id_csv, version_number")
          .eq("user_id", user.id)
          .order("version_number", { ascending: false })
          .limit(100),
      ]);
      if (jobsRes.error) throw jobsRes.error;
      const conversationTitles = new Map<string, string>();
      for (const conversation of convRes.data || []) {
        conversationTitles.set(conversation.id, customerFacingConversationTitle(conversation.title || ""));
      }
      const fileIdsByJob = new Map<string, JobDoc["fileIds"]>();
      for (const artifact of artifactsRes.data || []) {
        const fileIds = fileIdsByJob.get(artifact.job_id) || { xlsx: null, pdf: null, csv: null };
        fileIds.xlsx ||= artifact.file_id_xlsx || null;
        fileIds.pdf ||= artifact.file_id_pdf || null;
        fileIds.csv ||= artifact.file_id_csv || null;
        fileIdsByJob.set(artifact.job_id, fileIds);
      }

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
        fileIds: {
          xlsx: fileIdsByJob.get(r.id)?.xlsx || (String(r.result_file_id || "").endsWith(".xlsx") ? r.result_file_id : null),
          pdf: fileIdsByJob.get(r.id)?.pdf || (String(r.result_file_id || "").endsWith(".pdf") ? r.result_file_id : null),
          csv: fileIdsByJob.get(r.id)?.csv || (String(r.result_file_id || "").endsWith(".csv") ? r.result_file_id : null),
        },
      }));
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
          summaryAr: msgInfo?.summaryAr || customerFacingQuoteSummary(item?.capabilitySlug),
        };
      }
      setQuotes(qMap);

      const tMap: Record<string, string> = {};
      for (const c of (convRes.data || []) as any[]) {
        tMap[c.id || c.$id] = c.title;
      }
      setTitles(tMap);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [user]);

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

  // Orders are real jobs only: a planning attempt or a clarification-only conversation is not an order.
  const counts = useMemo(() => ({
    all: jobs.length,
    done: jobs.filter((j) => kindOfTab(kindOfJob(j)) === "done").length,
    running: jobs.filter((j) => kindOfTab(kindOfJob(j)) === "running").length,
    refunded: jobs.filter((j) => kindOfTab(kindOfJob(j)) === "refunded").length,
  }), [jobs]);
  const list = jobs.filter((j) => filter === "all" || kindOfTab(kindOfJob(j)) === filter);

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

  const openFile = (job: JobDoc, retry = false) => {
    // A request the source refused for its own content fails the same way again: it is opened, never re-quoted.
    retry = retry && !isDeterministicFailureAr(job.errorAr);
    try {
      sessionStorage.setItem("diger_active_job_id", job.$id);
      sessionStorage.setItem("diger_canvas_open", "1");
    } catch {
      // Non-blocking storage fallback
    }
    router.push(openJobHref({ jobId: job.$id, conversationId: quotes[job.$id]?.conversationId, retry }));
  };

  return (
    <div data-screen-label="Requests" className="flex-1">
      <div className="mx-auto flex max-w-[820px] flex-col gap-4 px-[18px] pb-16 pt-[22px]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="m-0 font-display text-[40px] font-medium leading-[1.1] text-ink">طلباتي</h1>
            <p className="mb-0 mt-1.5 text-sm font-light text-mut">كل أبحاثك وملفاتها في مكان واحد — التحميل متاح لمدة ٩٠ يومًا.</p>
          </div>
          <button type="button" onClick={() => startNewResearch(() => router.push("/dashboard/chat"))} className="min-h-11 cursor-pointer whitespace-nowrap rounded-full border-0 bg-ac px-[18px] text-[13px] text-onac">+ سؤال بحثي جديد</button>
        </div>

        <div className="no-scrollbar flex max-w-full gap-1 self-start overflow-x-auto rounded-full bg-sf2 p-1" role="tablist">
          {TABS.map(([id, label]) => {
            const on = filter === id;
            return (
              <button
                key={id} type="button" role="tab" aria-selected={on} onClick={() => setFilter(id)}
                className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-full border-0 px-3.5 text-[13px] font-medium"
                style={{ background: on ? "var(--sf)" : "transparent", color: on ? "var(--ink)" : "var(--mut)", boxShadow: on ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}
              >
                {label} <span className="opacity-60">{loading ? "…" : formatAr(counts[id])}</span>
              </button>
            );
          })}
        </div>

        {failed && <p role="alert" className="m-0 text-[13px] text-bad">تعذّر تحميل طلباتك الآن. تحقق من الاتصال ثم حاول مرة أخرى.</p>}
        {dlError && <p role="alert" className="m-0 text-[13px] text-bad">{dlError}</p>}
        {loading && [0, 1, 2].map((i) => <div key={i} className="h-40 rounded-3xl bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />)}


        {!loading && list.map((j) => {
          const k = kindOfJob(j);
          const st = STATUS[k];
          const q = quotes[j.$id];
          // A title stored before the plural rule says «٥ سجل»: it is read again at display time, the stored row stays as it is.
          const title = pluralizeStoredCountsAr((q?.conversationId && titles[q.conversationId]) || q?.summaryAr || targetOf(j.params) || `طلب ${customerFacingCapabilityLabel(j.templateSlug)}`);
          const requested = j.targetVolumeMax || q?.targetVolumeMax;
          const rows = j.rowsCollected ?? 0;
          // A finished request that delivered no record has no data file to offer: zero files, said once (the same rule as the results panel).
          // A request that did not settle and charge offers no file either, whatever it saved before settlement (resultsReleasable).
          const nothingDelivered = deliveredNothing({ kind: k, delivered: rows, deliveredKnown: j.deliveredKnown }) || !resultsReleasable({ status: j.status, charged_credits: j.chargedCredits });
          const pct = requested ? Math.min(100, (rows / requested) * 100) : 0;
          const stalled = k === "running" && isJobStalled({ status: j.status, updated_at: j.updatedAt ?? j.createdAt, lease_until: j.leaseUntil }, Date.now());
          const note = k === "running" ? `جارٍ الجمع — ${closePageLineAr(driverMode)}`
            : k === "refunded" ? `${formatRefundedNote(j.errorAr, j.reservedCredits || 0)}${rows > 0 && requested ? ` ${collectedBeforeStopText(rows, requested)}` : ""}`
            : nothingDelivered ? "لم يصل أي سجل، لذلك لا توجد ملفات بيانات لهذا الطلب، ولم يُخصم منك أي رصيد."
            : k === "partial" ? partialDeliveryText(rows, requested || rows) : "";
          const availableFormats = nothingDelivered ? [] : (["xlsx", "pdf", "csv"] as const).filter(
            (ext) => Boolean(j.fileIds[ext]),
          );
          const hasFiles = availableFormats.length > 0;
          return (
            <article key={j.$id} className="flex flex-col gap-3.5 rounded-3xl border border-ln bg-sf p-[18px]" style={{ animation: "up .35s both" }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <button
                    type="button"
                    data-testid="request-title"
                    // Opening a request only shows it; a retry is the «إعادة المحاولة» button below, never a tap on the title.
                    onClick={() => openFile(j)}
                    className="m-0 cursor-pointer border-0 bg-transparent p-0 text-right text-base font-medium leading-[1.6] text-ink hover:underline focus-visible:outline-2"
                  >
                    {title}
                  </button>
                  <p className="mb-0 mt-1 text-xs text-fnt">{customerFacingCapabilityLabel(j.templateSlug)} · {dayLabel(j.createdAt)}</p>
                </div>
                <span className="shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium" style={{ background: `color-mix(in oklab, ${st.tint} 13%, transparent)`, color: st.fg }}>{st.label}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 border-t border-ln pt-3 text-xs text-mut">
                <span>السجلات<br /><strong className="text-sm font-semibold text-ink">{formatAr(rows)}{requested ? ` / ${formatAr(requested)}` : ""}</strong></span>
                <span>النقاط المخصومة<br /><strong className="text-sm font-semibold text-ink">{k === "running" ? "محجوز" : formatAr(j.chargedCredits ?? 0)}</strong></span>
                <span>الملفات<br /><strong className="text-sm font-semibold text-ink">{hasFiles ? formatAr(availableFormats.length) : "—"}</strong></span>
              </div>
              {k === "running" && <div className="h-1 overflow-hidden rounded bg-sf2"><div className="h-full bg-gold" style={{ width: `${pct}%` }} /></div>}
              {k === "running" && progressByJob[j.$id] && <p className="m-0 text-[13px] leading-[1.8] text-ink2" data-testid="request-progress">{progressByJob[j.$id]}</p>}
              {stalled && <p role="status" className="m-0 text-[13px] font-medium leading-[1.8] text-ink" data-testid="request-stalled">{STALLED_LINE_AR}</p>}
              {note && <p className="m-0 text-[13px] leading-[1.8] text-ink2">{pluralizeStoredCountsAr(note)}</p>}
              {(k === "refunded" || k === "partial") && <ReportProblemButton jobId={j.$id} className="self-start" />}
              <div className="flex flex-wrap gap-2">
                {availableFormats.map((ext) => (
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
                  {k === "running" ? "متابعة التقدم" : k === "refunded" && !isDeterministicFailureAr(j.errorAr) ? "إعادة المحاولة" : "متابعة التفاصيل والملفات"}
                </button>
              </div>
            </article>
          );
        })}

        {!loading && !failed && list.length === 0 && (
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
