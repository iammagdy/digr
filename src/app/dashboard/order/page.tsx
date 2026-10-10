"use client";

import { useState, useEffect, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { client, databases } from "@/lib/appwrite";
import { useUser } from "@/hooks/useUser";
import { Functions, Query } from "appwrite";

const functions = new Functions(client);

interface Template {
  $id: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  paramsSchema: string;
  priceCreditsPerUnit: number;
  maxRows: number;
}

export default function OrderPage() {
  const { user } = useUser();
  const router = useRouter();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string>("tiktok-profile");
  const [username, setUsername] = useState<string>("");
  const [userBalance, setUserBalance] = useState<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState("");

  // Load public templates & user balance
  useEffect(() => {
    async function init() {
      try {
        const tRes = await databases.listDocuments("digr", "templates", [
          Query.equal("enabled", true),
          Query.limit(20),
        ]);
        const list = tRes.documents as unknown as Template[];
        setTemplates(list);
        if (list.length > 0 && !selectedSlug) {
          setSelectedSlug(list[0].slug);
        }

        // Fetch user balance
        if (user) {
          let total = 0;
          let offset = 0;
          const limit = 100;
          while (true) {
            const lRes = await databases.listDocuments("digr", "credit_ledger", [
              Query.equal("userId", user.$id),
              Query.limit(limit),
              Query.offset(offset),
            ]);
            for (const doc of lRes.documents) {
              total += (doc.delta as number) || 0;
            }
            if (lRes.documents.length < limit) break;
            offset += limit;
          }
          setUserBalance(total);
        }
      } catch (err: any) {
        console.error("Init order page error:", err);
      } finally {
        setInitialLoading(false);
      }
    }
    init();
  }, [user]);

  const selectedTemplate = templates.find((t) => t.slug === selectedSlug) || templates[0];
  const requiredCredits = selectedTemplate?.priceCreditsPerUnit || 1;
  const hasInsufficientBalance = userBalance !== null && userBalance < requiredCredits;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selectedTemplate) return;

    const cleanUsername = username.replace(/^@/, "").trim();
    if (!cleanUsername) {
      setError("يرجى كتابة اسم الحساب أولاً.");
      return;
    }

    if (hasInsufficientBalance) {
      setError("رصيدك الحالي غير كافٍ لإتمام هذا الطلب. يرجى شحن الرصيد أولاً.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const execution = await functions.createExecution(
        "create-job",
        JSON.stringify({
          templateSlug: selectedSlug,
          params: { username: cleanUsername },
        }),
        false
      );

      const resBody = JSON.parse(execution.responseBody || "{}");

      if (execution.responseStatusCode !== 200 || !resBody.success) {
        setError(resBody.error || "تعذر إنشاء الطلب. يرجى المحاولة مرة أخرى.");
        setLoading(false);
        return;
      }

      // Take user straight to the jobs page
      router.push("/dashboard/jobs");
    } catch (err: any) {
      setError(err.message || "حدث خطأ غير متوقع أثناء إرسال الطلب");
      setLoading(false);
    }
  }

  if (initialLoading) {
    return (
      <div className="flex min-h-[300px] items-center justify-center">
        <span className="text-sand-500">جاري تحميل الخدمات المتاحة...</span>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      {/* Header with simple intro */}
      <div className="rounded-2xl border border-sand-200 bg-white p-6 shadow-xs sm:p-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-sand-900">طلب استخراج جديد</h1>
            <p className="mt-1 text-base font-semibold text-accent">
              اختر الخدمة، اكتب اسم الحساب، ثم اضغط ابدأ
            </p>
          </div>
          {/* Balance Pill */}
          <div className="mt-2 inline-flex items-center gap-2 self-start rounded-xl bg-sand-50 px-4 py-2 border border-sand-200 sm:mt-0 sm:self-auto">
            <span className="text-xs text-sand-600">رصيدك الحالي:</span>
            <span className="text-sm font-bold text-sand-900">
              {userBalance !== null ? `${userBalance} رصيد` : "..."}
            </span>
          </div>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Main Form Area (2 cols) */}
        <div className="space-y-6 lg:col-span-2">
          {/* Step 1: Services Cards */}
          <div className="space-y-3">
            <h2 className="text-sm font-bold text-sand-800">1. الخدمة المتاحة:</h2>
            <div className="space-y-3">
              {templates.map((tmpl) => {
                const isSelected = tmpl.slug === selectedSlug;
                return (
                  <button
                    key={tmpl.slug}
                    type="button"
                    onClick={() => setSelectedSlug(tmpl.slug)}
                    className={`w-full rounded-2xl border p-5 text-right transition-all cursor-pointer ${
                      isSelected
                        ? "border-accent bg-accent/5 ring-2 ring-accent/30 shadow-xs"
                        : "border-sand-200 bg-white hover:border-sand-300"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                            isSelected
                              ? "border-accent bg-accent"
                              : "border-sand-300 bg-white"
                          }`}
                        >
                          {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                        </span>
                        <span className="text-base font-bold text-sand-900">
                          {tmpl.nameAr}
                        </span>
                      </div>
                      <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 border border-emerald-200">
                        {tmpl.priceCreditsPerUnit} رصيد
                      </span>
                    </div>
                    <p className="mt-2 pr-6 text-xs leading-relaxed text-sand-600">
                      {tmpl.descriptionAr}
                    </p>
                  </button>
                );
              })}

              {/* Coming soon note */}
              <div className="flex items-center justify-between rounded-xl border border-dashed border-sand-300 bg-sand-50/70 px-4 py-3 text-xs text-sand-500">
                <span>خدمات جديدة قريبًا (تحليلات المنشورات، إنستغرام، إكس)</span>
                <span className="rounded-full bg-sand-200/80 px-2 py-0.5 text-[10px] font-semibold text-sand-600">
                  قريبًا
                </span>
              </div>
            </div>
          </div>

          {/* Step 2: Account Input Form */}
          <div className="rounded-2xl border border-sand-200 bg-white p-6 shadow-xs">
            <h2 className="text-sm font-bold text-sand-800">2. اسم الحساب المطلوب:</h2>

            <form onSubmit={handleSubmit} className="mt-4 space-y-5">
              <div>
                <label
                  htmlFor="username"
                  className="block text-xs font-semibold text-sand-700 mb-1.5"
                >
                  اسم المستخدم (بدون علامة @)
                </label>
                <div className="flex rounded-xl border border-sand-300 bg-white focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
                  <span className="flex items-center px-3.5 text-sand-400 font-semibold" dir="ltr">
                    @
                  </span>
                  <input
                    id="username"
                    type="text"
                    required
                    dir="ltr"
                    placeholder="tiktok (بدون @)"
                    value={username}
                    onChange={(e) => setUsername(e.target.value.replace(/^@/, "").trim())}
                    className="w-full rounded-r-xl border-0 py-3 text-sm text-sand-900 placeholder:text-sand-400 focus:outline-none focus:ring-0"
                  />
                </div>
                <p className="mt-1.5 text-xs text-sand-500">
                  مثال: اكتب <span className="font-semibold text-sand-700">tiktok</span> أو <span className="font-semibold text-sand-700">khaby.lame</span> بدون علامة @
                </p>
              </div>

              {error && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs font-semibold text-danger">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || hasInsufficientBalance}
                className="w-full rounded-xl bg-accent px-5 py-3.5 text-sm font-bold text-white shadow-xs transition-all hover:bg-accent-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
              >
                {loading
                  ? "جاري تجهيز الطلب..."
                  : hasInsufficientBalance
                  ? "الرصيد غير كافٍ"
                  : `ابدأ الاستخراج (${requiredCredits} رصيد)`}
              </button>
            </form>
          </div>
        </div>

        {/* Sidebar Summary & Topup Link (1 col) */}
        <div className="space-y-6">
          <div className="rounded-2xl border border-sand-200 bg-white p-6 shadow-xs">
            <h3 className="text-sm font-bold text-sand-900">حالة الرصيد</h3>

            <div className="mt-4 space-y-3 text-xs">
              <div className="flex items-center justify-between border-b border-sand-100 pb-2.5">
                <span className="text-sand-600">رصيدك المتاح:</span>
                <span className="font-bold text-sand-900 text-sm">
                  {userBalance !== null ? `${userBalance} رصيد` : "..."}
                </span>
              </div>

              <div className="flex items-center justify-between border-b border-sand-100 pb-2.5">
                <span className="text-sand-600">تكلفة الخدمة:</span>
                <span className="font-bold text-accent text-sm">
                  {requiredCredits} رصيد
                </span>
              </div>

              <div className="flex items-center justify-between pt-1 font-semibold">
                <span className="text-sand-700">الرصيد بعد الخصم:</span>
                <span
                  className={
                    hasInsufficientBalance ? "text-danger font-bold" : "text-sand-900"
                  }
                >
                  {userBalance !== null ? `${Math.max(0, userBalance - requiredCredits)} رصيد` : "..."}
                </span>
              </div>
            </div>

            {hasInsufficientBalance && (
              <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-danger">
                <p className="font-bold">رصيدك الحالي غير كافٍ لإتمام هذا الطلب.</p>
                <p className="mt-1 text-sand-600">يرجى شحن الرصيد أولاً للمتابعة.</p>
                <div className="mt-3">
                  <Link
                    href="/dashboard/topup"
                    className="inline-flex items-center justify-center w-full rounded-lg bg-danger px-4 py-2 font-bold text-white shadow-xs transition-opacity hover:opacity-90"
                  >
                    شحن الرصيد الآن
                  </Link>
                </div>
              </div>
            )}
          </div>

          {/* Simple Explanation Note */}
          <div className="rounded-2xl border border-sand-200 bg-sand-50/80 p-5 text-xs text-sand-600">
            <p className="font-bold text-sand-800">كيف تعمل الخدمة؟</p>
            <p className="mt-1.5 leading-relaxed">
              عند الضغط على &quot;ابدأ الاستخراج&quot;، يتم حجز الرصيد آليًا والبدء في استخراج البيانات. فور اكتمال الطلب، ستتمكن من تحميل ملف النتائج مباشرة من صفحة الطلبات.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
