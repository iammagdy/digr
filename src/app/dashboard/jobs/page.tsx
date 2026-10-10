"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { client, databases, account } from "@/lib/appwrite";
import { useUser } from "@/hooks/useUser";
import { Storage, Query } from "appwrite";

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
        if (hasActive) {
          fetchJobs();
        }
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
      const evRes = await databases.listDocuments("digr", "job_events", [
        Query.equal("jobId", jobId),
        Query.orderAsc("createdAt"),
        Query.limit(20),
      ]);
      setEvents((prev) => ({
        ...prev,
        [jobId]: evRes.documents as unknown as JobEvent[],
      }));
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

      if (!res.ok) {
        throw new Error(`Download failed with status ${res.status}`);
      }

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
      const formatNames: Record<string, string> = {
        xlsx: "Excel (.xlsx)",
        pdf: "PDF (.pdf)",
        csv: "CSV (.csv)",
      };
      setDownloadError(`تعذر تحميل ملف ${formatNames[format] || format}. يرجى إعادة المحاولة.`);
    } finally {
      setDownloadingKey(null);
    }
  };

  const parseParams = (paramStr: string) => {
    try {
      const parsed = JSON.parse(paramStr || "{}");
      if (parsed.username) return `@${parsed.username.replace(/^@/, "")}`;
      if (parsed.query) return `بحث: ${parsed.query}`;
      return Object.entries(parsed)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
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

  // Filter jobs by search and status
  const filteredJobs = useMemo(() => {
    return jobs.filter((j) => {
      // Status filter
      if (statusFilter === "running" && j.status !== "running" && j.status !== "queued") return false;
      if (statusFilter === "done" && j.status !== "done") return false;
      if (statusFilter === "failed" && j.status !== "failed" && j.status !== "cancelled") return false;

      // Search filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const paramStr = (j.params || "").toLowerCase();
        const idStr = j.$id.toLowerCase();
        return paramStr.includes(q) || idStr.includes(q);
      }
      return true;
    });
  }, [jobs, statusFilter, searchQuery]);

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">سجل طلباتي</h1>
          <p className="mt-1 text-xs sm:text-sm text-ink-500">
            متابعة حالة الطلبات، استعراض مراحل المعالجة، وتحميل ملفات البيانات المستخرجة
          </p>
        </div>

        <Link
          href="/dashboard/chat"
          className="touch-target inline-flex items-center justify-center rounded-xl bg-ink-900 px-4 py-2.5 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-ink-800 transition-all text-center"
        >
          + طلب استخراج جديد
        </Link>
      </div>

      {downloadError && (
        <div className="flex items-center justify-between rounded-xl border border-red-200 bg-red-50 p-3.5 text-xs text-danger">
          <span>{downloadError}</span>
          <button
            type="button"
            onClick={() => setDownloadError(null)}
            className="text-xs font-semibold underline"
          >
            إغلاق
          </button>
        </div>
      )}

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3 rounded-2xl border border-sand-200 bg-white shadow-2xs">
        {/* Status Filters */}
        <div className="flex items-center gap-1 bg-sand-100/70 p-1 rounded-xl text-xs font-medium">
          <button
            onClick={() => setStatusFilter("all")}
            className={`touch-target px-3 py-1.5 rounded-lg transition-colors ${
              statusFilter === "all" ? "bg-white text-ink-900 font-semibold shadow-2xs" : "text-ink-600 hover:text-ink-900"
            }`}
          >
            الكل ({jobs.length})
          </button>
          <button
            onClick={() => setStatusFilter("running")}
            className={`touch-target px-3 py-1.5 rounded-lg transition-colors ${
              statusFilter === "running" ? "bg-white text-ink-900 font-semibold shadow-2xs" : "text-ink-600 hover:text-ink-900"
            }`}
          >
            قيد المعالجة
          </button>
          <button
            onClick={() => setStatusFilter("done")}
            className={`touch-target px-3 py-1.5 rounded-lg transition-colors ${
              statusFilter === "done" ? "bg-white text-ink-900 font-semibold shadow-2xs" : "text-ink-600 hover:text-ink-900"
            }`}
          >
            المكتملة
          </button>
          <button
            onClick={() => setStatusFilter("failed")}
            className={`touch-target px-3 py-1.5 rounded-lg transition-colors ${
              statusFilter === "failed" ? "bg-white text-ink-900 font-semibold shadow-2xs" : "text-ink-600 hover:text-ink-900"
            }`}
          >
            تعذر
          </button>
        </div>

        {/* Search Input */}
        <div className="w-full sm:w-64">
          <input
            type="text"
            placeholder="بحث بحساب أو معرف..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-sand-300 bg-sand-50/50 px-3.5 py-2 text-xs text-ink-900 placeholder:text-ink-400 focus:bg-white focus:border-ink-900"
          />
        </div>
      </div>

      {/* Jobs Cards Stream */}
      {loading ? (
        <div className="flex min-h-[300px] items-center justify-center">
          <div className="flex items-center gap-2 text-xs text-ink-500 font-medium">
            <span className="h-3.5 w-3.5 rounded-full border-2 border-ink-900 border-t-transparent animate-spin" />
            <span>جاري تحميل سجل الطلبات...</span>
          </div>
        </div>
      ) : filteredJobs.length === 0 ? (
        <div className="rounded-2xl border border-sand-200 bg-white p-12 text-center space-y-3 shadow-2xs">
          <div className="inline-flex p-3 rounded-2xl bg-sand-100 text-sand-600 mx-auto">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h3 className="text-base font-bold text-ink-900">لا توجد طلبات مطابقة</h3>
          <p className="text-xs text-ink-500 max-w-sm mx-auto">
            لم نجد أي طلبات تطابق معايير البحث المحددة. يمكنك بدء طلب جديد عبر المساعد الذكي.
          </p>
          <div className="pt-2">
            <Link
              href="/dashboard/chat"
              className="touch-target inline-flex items-center justify-center rounded-xl bg-ink-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-ink-800 transition-all"
            >
              بدء استخراج جديد
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredJobs.map((job) => {
            const isExpanded = expandedJobId === job.$id;
            const jobEventsList = events[job.$id] || [];

            return (
              <div
                key={job.$id}
                className="rounded-2xl border border-sand-200 bg-white p-5 shadow-2xs transition-all hover:border-sand-300 space-y-4"
              >
                {/* Order Card Top Bar */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-sand-100">
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sand-100 text-xs font-bold text-ink-800">
                      {job.templateSlug === "tiktok-profile" ? "تيك توك" : "بيانات"}
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-ink-900 font-mono" dir="ltr">
                          {parseParams(job.params)}
                        </span>
                        <span className="text-[11px] text-ink-400 font-mono" dir="ltr">
                          #{job.$id.slice(0, 8)}
                        </span>
                      </div>
                      <span className="text-[11px] text-ink-400">
                        {new Date(job.createdAt).toLocaleString("ar-EG", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </span>
                    </div>
                  </div>

                  {/* Status Badge & Charged Credits */}
                  <div className="flex items-center gap-3">
                    {job.status === "queued" && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                        قيد الانتظار
                      </span>
                    )}
                    {job.status === "running" && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                        <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-ping" />
                        جاري المعالجة...
                      </span>
                    )}
                    {job.status === "done" && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                        مكتمل ({job.rowsCollected || 1} سجل)
                      </span>
                    )}
                    {job.status === "failed" && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-danger">
                        تعذر الاكتمال
                      </span>
                    )}

                    <span className="rounded-lg bg-sand-100 px-2.5 py-1 text-xs font-bold text-ink-800 font-mono">
                      {job.status === "done"
                        ? `${job.chargedCredits ?? job.reservedCredits} نقطة`
                        : `حجز: ${job.reservedCredits} نقطة`}
                    </span>
                  </div>
                </div>

                {/* Actions & Deliverables Row */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  {/* Download Action Buttons */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {job.status === "done" ? (
                      <>
                        <button
                          type="button"
                          onClick={() => handleDownload(job, "xlsx")}
                          disabled={downloadingKey === `${job.$id}_xlsx`}
                          className="touch-target inline-flex items-center gap-1.5 rounded-xl bg-emerald-800 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-900 transition-colors shadow-2xs disabled:opacity-50"
                        >
                          {downloadingKey === `${job.$id}_xlsx` ? (
                            <span className="h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                          ) : (
                            <span>Excel (.xlsx)</span>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDownload(job, "pdf")}
                          disabled={downloadingKey === `${job.$id}_pdf`}
                          className="touch-target inline-flex items-center gap-1.5 rounded-xl bg-rose-800 px-3.5 py-2 text-xs font-semibold text-white hover:bg-rose-900 transition-colors shadow-2xs disabled:opacity-50"
                        >
                          {downloadingKey === `${job.$id}_pdf` ? (
                            <span className="h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                          ) : (
                            <span>PDF (.pdf)</span>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDownload(job, "csv")}
                          disabled={downloadingKey === `${job.$id}_csv`}
                          className="touch-target inline-flex items-center gap-1.5 rounded-xl bg-sky-800 px-3.5 py-2 text-xs font-semibold text-white hover:bg-sky-900 transition-colors shadow-2xs disabled:opacity-50"
                        >
                          {downloadingKey === `${job.$id}_csv` ? (
                            <span className="h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                          ) : (
                            <span>CSV (.csv)</span>
                          )}
                        </button>
                      </>
                    ) : (
                      <span className="text-xs text-ink-400">
                        {job.status === "failed" ? "تم استرداد الرصيد المحجوز بالكامل" : "الملفات ستتاح فور انتهاء الجمع"}
                      </span>
                    )}
                  </div>

                  {/* Secondary Actions: Timeline toggle & Re-run */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleReRunOrder(job)}
                      className="touch-target rounded-xl border border-sand-300 bg-white px-3 py-2 text-xs font-medium text-ink-700 hover:bg-sand-50 transition-colors"
                      title="فتح المساعد وإعادة إعداد هذا الطلب"
                    >
                      إعادة الطلب ⟳
                    </button>

                    <button
                      type="button"
                      onClick={() => loadJobEvents(job.$id)}
                      className="touch-target rounded-xl border border-sand-200 px-3 py-2 text-xs font-medium text-ink-600 hover:bg-sand-50 transition-colors"
                    >
                      {isExpanded ? "إخفاء السجل" : "سجل المراحل"}
                    </button>
                  </div>
                </div>

                {/* Collapsible Timeline */}
                {isExpanded && (
                  <div className="rounded-xl border border-sand-200 bg-sand-50/70 p-4 space-y-3 mt-3 animate-in fade-in duration-200">
                    <span className="text-xs font-bold text-ink-800 block">مراحل معالجة الطلب:</span>

                    {job.errorAr && (
                      <div className="rounded-lg bg-red-50 p-2.5 text-xs text-danger">
                        ملاحظة الخطأ: {job.errorAr}
                      </div>
                    )}

                    {loadingEvents === job.$id ? (
                      <div className="text-xs text-ink-400">جاري تحميل سجل الأحداث...</div>
                    ) : jobEventsList.length === 0 ? (
                      <div className="text-xs text-ink-400">لا توجد أحداث مسجلة لهذا الطلب.</div>
                    ) : (
                      <div className="space-y-2">
                        {jobEventsList.map((ev) => (
                          <div key={ev.$id} className="flex items-center justify-between text-xs text-ink-700">
                            <span className="flex items-center gap-2">
                              <span
                                className={`h-2 w-2 rounded-full ${
                                  ev.kind === "error"
                                    ? "bg-danger"
                                    : ev.kind === "progress"
                                    ? "bg-blue-600"
                                    : "bg-emerald-600"
                                }`}
                              />
                              <span>{ev.textAr}</span>
                            </span>
                            <span className="font-mono text-[11px] text-ink-400" dir="ltr">
                              {new Date(ev.createdAt).toLocaleTimeString("ar-EG")}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
