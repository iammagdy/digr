"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { client, databases, account } from "@/lib/appwrite";
import { useUser } from "@/hooks/useUser";
import { Storage, Query } from "appwrite";
import { Alert, Badge, Button, Card, EmptyState, Eyebrow, Input, Skeleton, Spinner, Tabs, type StatusTone } from "@/components/ui";
import {
  chronological,
  EVENT_HISTORY_LIMIT,
  eventHistoryScopeLabel,
  JOB_STATUS_LABEL_MAP,
  JOB_STATUS_TONE_MAP,
  formatNumber,
  formatDate,
} from "@/lib/honestDisplay";

const storage = new Storage(client);

interface Job {
  $id: string;
  templateSlug: string;
  params: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  estCredits: number;
  reservedCredits: number;
  chargedCredits?: number;
  rowsCollected?: number;
  resultFileId?: string;
  errorAr?: string;
  createdAt: string;
  finishedAt?: string;
}

interface JobEvent {
  $id: string;
  jobId: string;
  textAr: string;
  count?: number;
  kind: "info" | "progress" | "warning" | "error";
  createdAt: string;
}

const STATUS_META: Record<Job["status"], { label: string; tone: StatusTone }> = {
  queued: { label: JOB_STATUS_LABEL_MAP.queued, tone: JOB_STATUS_TONE_MAP.queued },
  running: { label: JOB_STATUS_LABEL_MAP.running, tone: JOB_STATUS_TONE_MAP.running },
  done: { label: JOB_STATUS_LABEL_MAP.done, tone: JOB_STATUS_TONE_MAP.done },
  failed: { label: JOB_STATUS_LABEL_MAP.failed, tone: JOB_STATUS_TONE_MAP.failed },
  cancelled: { label: JOB_STATUS_LABEL_MAP.cancelled, tone: JOB_STATUS_TONE_MAP.cancelled },
};

export default function JobsPage() {
  const { user } = useUser();
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "running" | "done" | "failed">("all");
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, JobEvent[]>>({});
  const [loadingEvents, setLoadingEvents] = useState<string | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    if (!user) return;
    try {
      const res = await databases.listDocuments("digr", "jobs", [
        Query.equal("userId", user.$id),
        Query.orderDesc("createdAt"),
        Query.limit(50),
      ]);
      setJobs(res.documents as unknown as Job[]);
    } catch (err: any) {
      console.error("Error fetching jobs:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(() => {
      setJobs((currentJobs) => {
        const hasActive = currentJobs.some((j) => j.status === "queued" || j.status === "running");
        if (hasActive) fetchJobs();
        return currentJobs;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  const loadJobEvents = async (jobId: string) => {
    if (expandedJobId === jobId) {
      setExpandedJobId(null);
      return;
    }
    setExpandedJobId(jobId);
    setLoadingEvents(jobId);
    try {
      // Latest events first from the server, restored to reading order for display.
      const evRes = await databases.listDocuments("digr", "job_events", [
        Query.equal("jobId", jobId),
        Query.orderDesc("createdAt"),
        Query.limit(EVENT_HISTORY_LIMIT),
      ]);
      setEvents((prev) => ({ ...prev, [jobId]: chronological(evRes.documents as unknown as JobEvent[]) }));
    } catch (err: any) {
      console.error("Error fetching events:", err);
    } finally {
      setLoadingEvents(null);
    }
  };

  const handleDownload = async (job: Job, format: "xlsx" | "pdf" | "csv") => {
    const key = `${job.$id}_${format}`;
    setDownloadingKey(key);
    setDownloadError(null);
    try {
      const jwtRes = await account.createJWT();
      const fileId = `${format}_${job.$id}`;
      const downloadUrl = storage.getFileDownload("results", fileId);
      const res = await fetch(downloadUrl, {
        headers: {
          "X-Appwrite-Project": process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!,
          "X-Appwrite-JWT": jwtRes.jwt,
        },
      });
      if (!res.ok) throw new Error(`Download failed with status ${res.status}`);
      const blob = await res.blob();
      const filename = `digr_${job.templateSlug || "dataset"}_${job.$id.slice(0, 8)}.${format}`;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }, 250);
    } catch (err: any) {
      console.error("Download error:", err);
      const formatNames: Record<string, string> = { xlsx: "Excel (.xlsx)", pdf: "PDF (.pdf)", csv: "CSV (.csv)" };
      setDownloadError(`تعذّر تحميل ملف ${formatNames[format] || format}. يرجى إعادة المحاولة.`);
    } finally {
      setDownloadingKey(null);
    }
  };

  const parseParams = (paramStr: string) => {
    try {
      const parsed = JSON.parse(paramStr || "{}");
      if (parsed.username) return `@${parsed.username.replace(/^@/, "")}`;
      if (parsed.query) return `بحث: ${parsed.query}`;
      return Object.entries(parsed).map(([k, v]) => `${k}: ${v}`).join(", ");
    } catch {
      return paramStr;
    }
  };

  const handleReRunOrder = (job: Job) => {
    let target = "";
    try {
      const p = JSON.parse(job.params || "{}");
      target = p.username ? `@${p.username}` : p.query || "";
    } catch {}
    const prompt = target
      ? `أريد استخراج بيانات الحساب ${target} وتحديث إحصائياته`
      : "أريد استخراج بيانات جديدة مماثلة لطلبي السابق";
    router.push(`/dashboard/chat?prompt=${encodeURIComponent(prompt)}`);
  };

  const filteredJobs = useMemo(() => {
    return jobs.filter((j) => {
      if (statusFilter === "running" && j.status !== "running" && j.status !== "queued") return false;
      if (statusFilter === "done" && j.status !== "done") return false;
      if (statusFilter === "failed" && j.status !== "failed" && j.status !== "cancelled") return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        return (j.params || "").toLowerCase().includes(q) || j.$id.toLowerCase().includes(q);
      }
      return true;
    });
  }, [jobs, statusFilter, searchQuery]);

  const counts = useMemo(() => ({
    all: jobs.length,
    running: jobs.filter((j) => j.status === "running" || j.status === "queued").length,
    done: jobs.filter((j) => j.status === "done").length,
    failed: jobs.filter((j) => j.status === "failed" || j.status === "cancelled").length,
  }), [jobs]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>سجل النشاط</Eyebrow>
          <h1 className="font-display mt-2 text-3xl text-ink-900">طلباتي</h1>
          <p className="mt-1.5 text-sm text-ink-600">تابع حالة طلباتك واستعرض سجل الأحداث وحمّل ملفاتك.</p>
        </div>
        <Link href="/dashboard/chat" className="inline-flex min-h-11 items-center gap-2 rounded-2xl bg-accent px-5 py-2.5 text-sm font-bold text-white shadow-[var(--shadow-ink)] transition-colors hover:bg-accent-hover">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
          طلب جديد
        </Link>
      </div>

      {downloadError && (
        <Alert tone="danger" title="تعذّر التحميل">
          <div className="flex items-center justify-between gap-3">
            <span>{downloadError}</span>
            <button type="button" onClick={() => setDownloadError(null)} className="shrink-0 font-bold underline cursor-pointer">إغلاق</button>
          </div>
        </Alert>
      )}

      {/* Filters */}
      <Card className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          tabs={[
            { id: "all" as const, label: "الكل", count: counts.all },
            { id: "running" as const, label: "قيد التنفيذ", count: counts.running },
            { id: "done" as const, label: "المكتملة", count: counts.done },
            { id: "failed" as const, label: "المتعثرة", count: counts.failed },
          ]}
          active={statusFilter}
          onChange={setStatusFilter}
        />
        <div className="w-full sm:w-64">
          <Input type="search" placeholder="بحث بحساب أو معرّف..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} aria-label="بحث في الطلبات" />
        </div>
      </Card>

      {/* Jobs list */}
      {loading ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 w-full" />)}</div>
      ) : filteredJobs.length === 0 ? (
        <Card>
          <EmptyState
            title={jobs.length === 0 ? "لا توجد طلبات بعد" : "لا توجد طلبات مطابقة"}
            description={jobs.length === 0 ? "ابدأ أول بحث لك من المساعد البحثي — سيظهر هنا مع حالته وملفاته." : "جرّب تعديل البحث أو فلتر الحالة."}
            action={
              <Link href="/dashboard/chat" className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white hover:bg-primary-hover">
                بدء استخراج جديد
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredJobs.map((job) => {
            const isExpanded = expandedJobId === job.$id;
            const jobEventsList = events[job.$id] || [];
            const meta = STATUS_META[job.status];
            const isActive = job.status === "queued" || job.status === "running";
            return (
              <Card key={job.$id} className={`overflow-hidden transition-colors ${isActive ? "border-accent/40" : ""}`}>
                <div className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-pine-800 text-xs font-bold text-white">
                        {job.templateSlug === "tiktok-profile" ? "تك" : "ب"}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-ink-900" dir="auto">{parseParams(job.params)}</p>
                        <p className="tnum mt-0.5 text-xs text-sand-500">
                          {formatDate(job.createdAt, { dateStyle: "medium", timeStyle: "short" })}
                          <span dir="ltr" className="ms-2">#{job.$id.slice(0, 8)}</span>
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={meta.tone}>
                        {isActive && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse motion-reduce:animate-none" />}
                        {meta.label}
                        {job.status === "done" && typeof job.rowsCollected === "number" && (
                          <span className="tnum"> · {formatNumber(job.rowsCollected)} سجل</span>
                        )}
                      </Badge>
                      <span className="tnum rounded-xl bg-sand-100 px-2.5 py-1.5 text-xs font-bold text-ink-800">
                        {job.status === "done" ? `${formatNumber(job.chargedCredits ?? job.reservedCredits)} نقطة` : `حجز: ${formatNumber(job.reservedCredits)} نقطة`}
                      </span>
                    </div>
                  </div>

                  {job.errorAr && (
                    <Alert tone="danger" title="ملاحظة الخطأ">
                      <div className="mt-3">{job.errorAr}</div>
                    </Alert>
                  )}

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-sand-100 pt-4">
                    <div className="flex flex-wrap items-center gap-2">
                      {job.status === "done" ? (
                        (["xlsx", "pdf", "csv"] as const).map((fmt) => (
                          <Button
                            key={fmt}
                            size="sm"
                            variant="secondary"
                            onClick={() => handleDownload(job, fmt)}
                            disabled={downloadingKey === `${job.$id}_${fmt}`}
                            className="tnum uppercase"
                          >
                            {downloadingKey === `${job.$id}_${fmt}` ? "جاري..." : `تحميل ${fmt}`}
                          </Button>
                        ))
                      ) : (
                        <span className="text-xs text-sand-500">
                          {job.status === "failed" || job.status === "cancelled"
                            ? "تم استرداد الرصيد المحجوز بالكامل إلى محفظتك."
                            : "ستتاح الملفات فور انتهاء الجمع."}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="ghost" onClick={() => handleReRunOrder(job)}>
                        إعادة الطلب ⟳
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => loadJobEvents(job.$id)} aria-expanded={isExpanded}>
                        {isExpanded ? "إخفاء السجل" : "سجل الأحداث"}
                      </Button>
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="animate-fade border-t border-sand-100 bg-sand-50/60 p-5">
                    <h3 className="mb-3 text-xs font-bold text-ink-800">
                      سجل الأحداث المسجّلة
                      <span className="ms-2 font-medium text-sand-500">({eventHistoryScopeLabel()})</span>
                    </h3>
                    {loadingEvents === job.$id ? (
                      <div className="flex items-center gap-2 text-xs text-sand-500"><Spinner label="جاري تحميل الأحداث" /></div>
                    ) : jobEventsList.length === 0 ? (
                      <p className="text-xs text-sand-500">لا توجد أحداث مسجلة لهذا الطلب بعد.</p>
                    ) : (
                      <ol className="space-y-2.5">
                        {jobEventsList.map((ev) => (
                          <li key={ev.$id} className="flex items-start justify-between gap-3 text-xs">
                            <span className="flex items-start gap-2">
                              <span aria-hidden="true" className={`mt-1 h-2 w-2 shrink-0 rounded-full ${ev.kind === "error" ? "bg-danger" : ev.kind === "warning" ? "bg-warning" : ev.kind === "progress" ? "bg-info" : "bg-success"}`} />
                              <span className="font-medium text-ink-800">{ev.textAr}</span>
                            </span>
                            <time className="tnum shrink-0 text-sand-500" dateTime={ev.createdAt}>
                              {new Date(ev.createdAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })}
                            </time>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
