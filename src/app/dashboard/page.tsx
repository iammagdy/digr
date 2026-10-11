"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { databases } from "@/lib/appwrite";
import { useUser } from "@/hooks/useUser";
import { Query } from "appwrite";
import { Alert, Badge, Card, EmptyState, Eyebrow, Skeleton, Stat } from "@/components/ui";
import {
  balanceLoading,
  balanceReady,
  balanceFailed,
  balanceText,
  showDerivedAmounts,
  jobTotalFromResponse,
  jobCountText,
  formatCurrency,
  formatNumber,
  formatDate,
  formatJobStatus,
  formatJobStatusTone,
  type BalanceView,
} from "@/lib/honestDisplay";

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

function jobTitle(job: RecentJob): string {
  try {
    const p = JSON.parse(job.params || "{}");
    return p.username ? `@${p.username}` : p.query || "بيانات عامة";
  } catch {
    return "بيانات عامة";
  }
}

export default function DashboardOverviewPage() {
  const { user } = useUser();
  const [balance, setBalance] = useState<BalanceView>(balanceLoading());
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>([]);
  const [totalJobs, setTotalJobs] = useState<number | null>(null);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const fetchOverviewData = useCallback(async () => {
    if (!user) return;
    setBalance(balanceLoading());
    setJobsLoading(true);
    setLoadError(false);
    // Ledger balance — independent of the jobs query so one failure
    // never poisons the other display.
    try {
      let total = 0;
      let offset = 0;
      const limit = 100;
      while (true) {
        const res = await databases.listDocuments("digr", "credit_ledger", [
          Query.equal("userId", user.$id),
          Query.limit(limit),
          Query.offset(offset),
        ]);
        for (const doc of res.documents) total += (doc.delta as number) || 0;
        if (res.documents.length < limit) break;
        offset += limit;
      }
      // A genuinely successful query may legitimately total zero.
      setBalance(balanceReady(total));
    } catch {
      // A failed request proves nothing about the balance — never show a fake zero.
      setBalance(balanceFailed());
      setLoadError(true);
    }
    try {
      const jobsRes = await databases.listDocuments("digr", "jobs", [
        Query.equal("userId", user.$id),
        Query.orderDesc("createdAt"),
        Query.limit(5),
      ]);
      setRecentJobs(jobsRes.documents as unknown as RecentJob[]);
      // Authoritative total comes from the response itself, never from the page length.
      setTotalJobs(jobTotalFromResponse(jobsRes.total));
    } catch {
      setRecentJobs([]);
      setTotalJobs(null);
      setLoadError(true);
    } finally {
      setJobsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void fetchOverviewData();
  }, [fetchOverviewData]);

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6">
      {/* Heading */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>مساحة العمل</Eyebrow>
          <h1 className="font-display mt-2 text-3xl text-ink-900">
            أهلاً {user?.name?.split(" ")[0] ?? "بك"}
          </h1>
          <p className="mt-1.5 text-sm text-ink-600">تابع رصيدك وطلباتك الأخيرة — وابدأ بحثًا جديدًا متى شئت.</p>
        </div>
        <Link
          href="/dashboard/chat"
          className="inline-flex min-h-12 items-center gap-2 rounded-2xl bg-accent px-6 py-3 text-sm font-bold text-white shadow-[var(--shadow-ink)] transition-colors hover:bg-accent-hover"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          بحث جديد
        </Link>
      </div>

      {loadError && (
        <Alert tone="warning" title="تعذّر تحميل بعض البيانات">
          تحقق من اتصالك بالإنترنت ثم حدّث الصفحة. <button type="button" onClick={() => void fetchOverviewData()} className="font-bold underline cursor-pointer">إعادة المحاولة</button>
        </Alert>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="border-t-2 border-t-amber-points p-5">
          <p className="text-xs font-semibold text-sand-500">رصيد النقاط المتاح</p>
          {balance.status === "loading" ? (
            <Skeleton className="mt-2 h-9 w-28" />
          ) : (
            <p className="tnum mt-1.5 text-3xl font-bold text-ink-900">
              {balanceText(balance)} <span className="text-sm font-bold text-amber-points">نقطة</span>
            </p>
          )}
          <div className="mt-3 flex items-center justify-between border-t border-sand-100 pt-3 text-xs">
            <span className="tnum text-sand-500">
              {showDerivedAmounts(balance) ? `≈ ${formatCurrency((balance.value ?? 0) * 0.1)}` : "—"}
            </span>
            <Link href="/dashboard/topup" className="font-bold text-amber-points hover:underline">شحن الرصيد ←</Link>
          </div>
          {balance.status === "failed" && (
            <p className="mt-2 text-xs text-warning">
              تعذّر تحميل الرصيد — <button type="button" onClick={() => void fetchOverviewData()} className="font-bold underline cursor-pointer">إعادة المحاولة</button>
            </p>
          )}
        </Card>
        <Card className="p-5">
          <p className="text-xs font-semibold text-sand-500">إجمالي طلبات البحث</p>
          {jobsLoading ? (
            <Skeleton className="mt-2 h-9 w-20" />
          ) : (
            <p className="tnum mt-1.5 text-3xl font-bold text-ink-900">{jobCountText(totalJobs)}<span className="text-sm font-semibold text-sand-500"> طلب</span></p>
          )}
          <div className="mt-3 flex items-center justify-between border-t border-sand-100 pt-3 text-xs">
            <span className="text-sand-500">سجل المعالجات الكامل</span>
            <Link href="/dashboard/jobs" className="font-bold text-ink-700 hover:underline">عرض الكل ←</Link>
          </div>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-semibold text-sand-500">سعر النقطة</p>
          <p className="tnum mt-1.5 text-3xl font-bold text-ink-900">{formatNumber(0.1, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-sm font-semibold text-sand-500">ج.م</span></p>
          <div className="mt-3 flex items-center justify-between border-t border-sand-100 pt-3 text-xs">
            <span className="text-sand-500">الدفع عبر انستاباي</span>
            <Badge tone="success">نشط ومعتمد</Badge>
          </div>
        </Card>
      </div>

      {/* Recent jobs */}
      <section aria-label="أحدث الطلبات">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink-900">أحدث الطلبات</h2>
          <Link href="/dashboard/jobs" className="text-sm font-bold text-accent hover:underline">كل الطلبات ←</Link>
        </div>
        <Card className="divide-y divide-sand-100 overflow-hidden">
          {jobsLoading ? (
            <div className="space-y-3 p-5">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : recentJobs.length === 0 ? (
            <EmptyState
              title="لا توجد طلبات بعد"
              description="ابدأ أول بحث لك — سيظهر هنا مع حالته وملفاته."
              action={
                <Link href="/dashboard/chat" className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white hover:bg-primary-hover">
                  ابدأ بحثك الأول
                </Link>
              }
            />
          ) : (
            recentJobs.map((job) => (
              <Link key={job.$id} href="/dashboard/jobs" className="flex items-center gap-4 p-4 transition-colors hover:bg-sand-50/70 sm:px-5">
                <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sand-100 text-sand-600">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-ink-900">{jobTitle(job)}</p>
                  <p className="tnum mt-0.5 text-xs text-sand-500">
                    {formatDate(job.createdAt)}
                    {typeof job.rowsCollected === "number" && ` · ${formatNumber(job.rowsCollected)} سجل`}
                  </p>
                </div>
                <Badge tone={formatJobStatusTone(job.status)}>{formatJobStatus(job.status)}</Badge>
              </Link>
            ))
          )}
        </Card>
      </section>

      {/* Honest note */}
      <Stat
        tone="neutral"
        label="مبدأ Digr المالي"
        value="لا خصم قبل التسليم"
        sub="يُحجز المبلغ التقديري عند موافقتك، ويُخصم النهائي الدقيق بعد تسليم السجلات فقط — والفرق يُرد تلقائيًا."
      />
    </div>
  );
}
