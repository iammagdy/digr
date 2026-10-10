"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { databases } from "@/lib/appwrite";
import { useUser } from "@/hooks/useUser";
import { Query } from "appwrite";

interface RecentJob {
  $id: string;
  templateSlug: string;
  params: string;
  status: string;
  chargedCredits?: number;
  reservedCredits?: number;
  rowsCollected?: number;
  createdAt: string;
}

export default function DashboardOverviewPage() {
  const { user } = useUser();
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);

  const fetchOverviewData = useCallback(async () => {
    if (!user) return;
    setBalanceLoading(true);
    setJobsLoading(true);
    try {
      // 1. Compute balance
      let total = 0;
      let offset = 0;
      const limit = 100;
      while (true) {
        const res = await databases.listDocuments("digr", "credit_ledger", [
          Query.equal("userId", user.$id),
          Query.limit(limit),
          Query.offset(offset),
        ]);
        for (const doc of res.documents) {
          total += (doc.delta as number) || 0;
        }
        if (res.documents.length < limit) break;
        offset += limit;
      }
      setBalance(total);

      // 2. Fetch latest 5 jobs
      const jobsRes = await databases.listDocuments("digr", "jobs", [
        Query.equal("userId", user.$id),
        Query.orderDesc("createdAt"),
        Query.limit(5),
      ]);
      setRecentJobs(jobsRes.documents as unknown as RecentJob[]);
    } catch (err) {
      console.error("Failed to fetch dashboard data:", err);
      setBalance(0);
    } finally {
      setBalanceLoading(false);
      setJobsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchOverviewData();
  }, [fetchOverviewData]);

  const parseTarget = (paramsStr: string) => {
    try {
      const p = JSON.parse(paramsStr || "{}");
      return p.username ? `@${p.username}` : p.query || "بيانات عامة";
    } catch {
      return "بيانات عامة";
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 space-y-8 text-right">
      {/* Welcome Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-sand-200">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">
            مرحبًا بك{user?.name ? `، ${user.name}` : ""}
          </h1>
          <p className="mt-1 text-xs sm:text-sm text-ink-500">
            مساحة عملك لاستخراج البيانات العامة ومتابعة ملفات الأبحاث والتحليل
          </p>
        </div>

        <Link
          href="/dashboard/chat"
          className="touch-target inline-flex items-center justify-center rounded-xl bg-ink-900 px-5 py-2.5 text-xs sm:text-sm font-semibold text-white hover:bg-ink-800 transition-all shadow-xs text-center"
        >
          + فتح المساعد الذكي
        </Link>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Balance Card */}
        <div className="rounded-2xl border border-sand-200 bg-white p-5 shadow-2xs space-y-1">
          <span className="text-xs font-semibold text-ink-400">الرصيد المتاح بالمحفظة</span>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-bold text-ink-900 font-mono">
              {balanceLoading ? "..." : (balance ?? 0).toLocaleString("ar-EG")}
            </span>
            <span className="text-xs font-bold text-amber-points">نقطة</span>
          </div>
          <div className="pt-2 flex items-center justify-between border-t border-sand-100 text-[11px]">
            <span className="text-ink-400">
              يعادل: {balance !== null ? ((balance * 0.1)).toFixed(2) : "0.00"} ج.م
            </span>
            <Link href="/dashboard/topup" className="font-semibold text-amber-points hover:underline">
              شحن المحفظة ←
            </Link>
          </div>
        </div>

        {/* Total Orders Card */}
        <div className="rounded-2xl border border-sand-200 bg-white p-5 shadow-2xs space-y-1">
          <span className="text-xs font-semibold text-ink-400">إجمالي الطلبات</span>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-bold text-ink-900 font-mono">
              {jobsLoading ? "..." : recentJobs.length}
            </span>
            <span className="text-xs text-ink-500">طلب مسجل</span>
          </div>
          <div className="pt-2 flex items-center justify-between border-t border-sand-100 text-[11px]">
            <span className="text-ink-400">سجل المعالجات الكامل</span>
            <Link href="/dashboard/jobs" className="font-semibold text-ink-700 hover:underline">
              عرض الكل ←
            </Link>
          </div>
        </div>

        {/* Pricing Ratio Card */}
        <div className="rounded-2xl border border-sand-200 bg-white p-5 shadow-2xs space-y-1">
          <span className="text-xs font-semibold text-ink-400">سعر النقطة بالجنيه</span>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-bold text-ink-900 font-mono">0.10</span>
            <span className="text-xs text-ink-500">ج.م / نقطة</span>
          </div>
          <div className="pt-2 flex items-center justify-between border-t border-sand-100 text-[11px]">
            <span className="text-ink-400">الدفع عبر انستاباي</span>
            <span className="text-emerald-700 font-semibold">نشط ومعتمد ✓</span>
          </div>
        </div>
      </div>

      {/* Quick Launch Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link
          href="/dashboard/chat"
          className="touch-target rounded-2xl border border-sand-200 bg-white p-5 transition-all hover:border-sand-300 hover:shadow-2xs flex flex-col justify-between"
        >
          <div>
            <div className="flex items-center justify-between">
              <span className="h-8 w-8 rounded-xl bg-ink-900 text-white flex items-center justify-center font-bold text-xs">
                دِ
              </span>
              <span className="text-xs font-semibold text-ink-400">المحادثة الذكية</span>
            </div>
            <h3 className="font-bold text-base text-ink-900 mt-3">استخراج بيانات جديدة عبر المساعد</h3>
            <p className="text-xs text-ink-500 mt-1 leading-relaxed">
              تحدث بلغة طبيعية مع المساعد الذكي لوصف البيانات المطلوبة واقتراح خطة التسعير قبل البدء.
            </p>
          </div>
          <span className="text-xs font-semibold text-ink-800 pt-4 flex items-center gap-1">
            <span>فتح المساعد</span>
            <span className="text-ink-400">←</span>
          </span>
        </Link>

        <Link
          href="/dashboard/topup"
          className="touch-target rounded-2xl border border-sand-200 bg-white p-5 transition-all hover:border-sand-300 hover:shadow-2xs flex flex-col justify-between"
        >
          <div>
            <div className="flex items-center justify-between">
              <span className="h-8 w-8 rounded-xl bg-amber-100 text-amber-900 flex items-center justify-center font-bold text-xs">
                <svg className="w-4 h-4 text-amber-800" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </span>
              <span className="text-xs font-semibold text-amber-points">شحن لحظي</span>
            </div>
            <h3 className="font-bold text-base text-ink-900 mt-3">شحن رصيد المحفظة عبر Instapay</h3>
            <p className="text-xs text-ink-500 mt-1 leading-relaxed">
              اشحن رصيد حسابك بالجنيه المصري للاستفادة من تسعير عادل بدون اشتراكات شهرية ملزمة.
            </p>
          </div>
          <span className="text-xs font-semibold text-ink-800 pt-4 flex items-center gap-1">
            <span>صفحة الشحن</span>
            <span className="text-ink-400">←</span>
          </span>
        </Link>
      </div>

      {/* Recent Orders Overview */}
      <div className="rounded-2xl border border-sand-200 bg-white p-6 shadow-2xs space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">أحدث الطلبات</h2>
          <Link href="/dashboard/jobs" className="text-xs font-semibold text-ink-600 hover:text-ink-900">
            سجل جميع الطلبات ←
          </Link>
        </div>

        {jobsLoading ? (
          <div className="py-6 text-center text-xs text-ink-400">جاري التحميل...</div>
        ) : recentJobs.length === 0 ? (
          <div className="py-8 text-center text-xs text-ink-400 space-y-2">
            <p>لا توجد طلبات سابقة حتى الآن.</p>
            <Link href="/dashboard/chat" className="text-ink-800 font-semibold underline block">
              ابدأ أول طلب استخراج عبر المساعد
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-sand-100">
            <table className="w-full text-right text-xs">
              <thead className="bg-sand-50 border-b border-sand-200 text-ink-500 font-medium">
                <tr>
                  <th className="p-3">الهدف</th>
                  <th className="p-3">الحالة</th>
                  <th className="p-3">النقاط</th>
                  <th className="p-3">التاريخ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-100 font-mono text-ink-800">
                {recentJobs.map((job) => (
                  <tr key={job.$id} className="hover:bg-sand-50/50">
                    <td className="p-3 font-semibold text-ink-900" dir="ltr">
                      {parseTarget(job.params)}
                    </td>
                    <td className="p-3">
                      {job.status === "done" && (
                        <span className="rounded-full bg-emerald-50 text-emerald-800 px-2 py-0.5 text-[10px] font-sans font-semibold">
                          مكتمل ✓
                        </span>
                      )}
                      {job.status === "running" && (
                        <span className="rounded-full bg-blue-50 text-blue-700 px-2 py-0.5 text-[10px] font-sans font-semibold">
                          جاري...
                        </span>
                      )}
                      {job.status === "failed" && (
                        <span className="rounded-full bg-red-50 text-danger px-2 py-0.5 text-[10px] font-sans font-semibold">
                          تعذر
                        </span>
                      )}
                      {job.status === "queued" && (
                        <span className="rounded-full bg-amber-50 text-amber-800 px-2 py-0.5 text-[10px] font-sans font-semibold">
                          انتظار
                        </span>
                      )}
                    </td>
                    <td className="p-3">{job.chargedCredits ?? job.reservedCredits} نقطة</td>
                    <td className="p-3 text-ink-400 font-sans" dir="ltr">
                      {new Date(job.createdAt).toLocaleDateString("ar-EG")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
