"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { client, databases } from "@/lib/appwrite";
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
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, JobEvent[]>>({});
  const [loadingEvents, setLoadingEvents] = useState<string | null>(null);

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

  // Initial fetch and auto-refresh when there are active jobs
  useEffect(() => {
    fetchJobs();

    const interval = setInterval(() => {
      // If any job is currently queued or running, poll updates
      setJobs((currentJobs) => {
        const hasActive = currentJobs.some(
          (j) => j.status === "queued" || j.status === "running"
        );
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

  const getDownloadUrl = (fileId: string) => {
    return storage.getFileDownload("results", fileId).toString();
  };

  const parseParams = (paramStr: string) => {
    try {
      const parsed = JSON.parse(paramStr || "{}");
      if (parsed.username) return `@${parsed.username}`;
      return Object.entries(parsed)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
    } catch {
      return paramStr;
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-sand-900">طلباتي</h1>
          <p className="mt-1 text-sm text-sand-500">
            متابعة حالة الطلبات، استعراض سجل الأحداث وتحميل ملفات البيانات المستخرجة
          </p>
        </div>
        <Link
          href="/dashboard/order"
          className="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
        >
          + طلب بيانات جديد
        </Link>
      </div>

      {loading ? (
        <div className="flex min-h-[250px] items-center justify-center">
          <span className="text-sand-500">جاري تحميل سجل الطلبات...</span>
        </div>
      ) : jobs.length === 0 ? (
        <div className="rounded-xl border border-sand-200 bg-white p-12 text-center">
          <h3 className="text-base font-semibold text-sand-800">لا توجد طلبات سابقة</h3>
          <p className="mt-1 text-sm text-sand-500">
            لم تقم بإنشاء أي طلب بعد. يمكنك بدء جمع البيانات الآن.
          </p>
          <div className="mt-5">
            <Link
              href="/dashboard/order"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            >
              إنشاء أول طلب
            </Link>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-sand-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-sm">
              <thead className="border-b border-sand-200 bg-sand-50 text-xs font-semibold text-sand-600">
                <tr>
                  <th className="px-5 py-3.5">الطلب / القالب</th>
                  <th className="px-5 py-3.5">المدخلات</th>
                  <th className="px-5 py-3.5">الحالة</th>
                  <th className="px-5 py-3.5">الرصيد</th>
                  <th className="px-5 py-3.5">تاريخ الطلب</th>
                  <th className="px-5 py-3.5">الإجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-100">
                {jobs.map((job) => {
                  const isExpanded = expandedJobId === job.$id;
                  const jobEventsList = events[job.$id] || [];

                  return (
                    <tr key={job.$id} className="group hover:bg-sand-50/50">
                      <td colSpan={6} className="p-0">
                        <div className="grid grid-cols-6 items-center px-5 py-4">
                          {/* Template Name & ID */}
                          <div>
                            <span className="font-semibold text-sand-900">
                              {job.templateSlug === "tiktok-profile"
                                ? "ملف تيك توك"
                                : job.templateSlug}
                            </span>
                            <span className="block font-mono text-xs text-sand-400" dir="ltr">
                              {job.$id.slice(0, 12)}...
                            </span>
                          </div>

                          {/* Inputs */}
                          <div className="font-mono text-xs text-sand-700" dir="ltr">
                            {parseParams(job.params)}
                          </div>

                          {/* Status Badge */}
                          <div>
                            {job.status === "queued" && (
                              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
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
                              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                مكتمل ✓
                              </span>
                            )}
                            {job.status === "failed" && (
                              <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-danger">
                                <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                                تعذر الاكتمال
                              </span>
                            )}
                          </div>

                          {/* Credits */}
                          <div className="text-xs">
                            {job.status === "done" ? (
                              <span className="font-bold text-sand-900">
                                {job.chargedCredits ?? job.reservedCredits} رصيد
                              </span>
                            ) : (
                              <span className="text-sand-500">
                                حجز: {job.reservedCredits} رصيد
                              </span>
                            )}
                          </div>

                          {/* Date */}
                          <div className="text-xs text-sand-500" dir="ltr">
                            {new Date(job.createdAt).toLocaleString("ar-EG", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-2">
                            {job.status === "done" && job.resultFileId && (
                              <a
                                href={getDownloadUrl(job.resultFileId)}
                                download
                                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
                              >
                                تحميل النتائج
                              </a>
                            )}

                            <button
                              type="button"
                              onClick={() => loadJobEvents(job.$id)}
                              className="rounded border border-sand-200 px-2.5 py-1.5 text-xs text-sand-600 transition-colors hover:bg-sand-100"
                            >
                              {isExpanded ? "إخفاء السجل" : "سجل الأحداث"}
                            </button>
                          </div>
                        </div>

                        {/* Expandable Events Timeline */}
                        {isExpanded && (
                          <div className="border-t border-sand-100 bg-sand-50/70 p-5">
                            <h4 className="text-xs font-bold text-sand-700">
                              سجل مراحل معالجة الطلب:
                            </h4>

                            {job.errorAr && (
                              <div className="mt-2 rounded bg-red-50 p-2.5 text-xs text-danger">
                                سبب الفشل: {job.errorAr}
                              </div>
                            )}

                            {loadingEvents === job.$id ? (
                              <div className="mt-2 text-xs text-sand-400">
                                جاري تحميل الأحداث...
                              </div>
                            ) : jobEventsList.length === 0 ? (
                              <div className="mt-2 text-xs text-sand-400">
                                لا توجد أحداث مسجلة لهذا الطلب.
                              </div>
                            ) : (
                              <ul className="mt-3 space-y-2">
                                {jobEventsList.map((ev) => (
                                  <li
                                    key={ev.$id}
                                    className="flex items-center justify-between text-xs text-sand-600"
                                  >
                                    <span className="flex items-center gap-2">
                                      <span
                                        className={`h-2 w-2 rounded-full ${
                                          ev.kind === "error"
                                            ? "bg-danger"
                                            : ev.kind === "progress"
                                            ? "bg-blue-500"
                                            : "bg-emerald-500"
                                        }`}
                                      />
                                      {ev.textAr}
                                    </span>
                                    <span className="font-mono text-[11px] text-sand-400" dir="ltr">
                                      {new Date(ev.createdAt).toLocaleTimeString("ar-EG")}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
