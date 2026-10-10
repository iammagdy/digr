"use client";

import { useState, useEffect, useCallback, type FormEvent } from "react";
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
  const [params, setParams] = useState<Record<string, string>>({ username: "" });
  const [userBalance, setUserBalance] = useState<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

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

        // Fetch balance
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

  const selectedTemplate = templates.find((t) => t.slug === selectedSlug);
  const requiredCredits = selectedTemplate?.priceCreditsPerUnit || 1;
  const hasInsufficientBalance = userBalance !== null && userBalance < requiredCredits;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selectedTemplate) return;

    if (hasInsufficientBalance) {
      setError("رصيدك الحالي غير كافٍ لإتمام هذا الطلب. يرجى شحن الرصيد أولاً.");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");

    try {
      const execution = await functions.createExecution(
        "create-job",
        JSON.stringify({
          templateSlug: selectedSlug,
          params,
        }),
        false
      );

      const resBody = JSON.parse(execution.responseBody || "{}");

      if (execution.responseStatusCode !== 200 || !resBody.success) {
        setError(resBody.error || "تعذر إنشاء الطلب. يرجى المحاولة مرة أخرى.");
        return;
      }

      setSuccess("تم إنشاء الطلب وحجز الرصيد بنجاح! جاري الانتقال إلى قائمة طلباتك...");
      setTimeout(() => {
        router.push("/dashboard/jobs");
      }, 1200);
    } catch (err: any) {
      setError(err.message || "حدث خطأ غير متوقع أثناء إرسال الطلب");
    } finally {
      setLoading(false);
    }
  }

  if (initialLoading) {
    return (
      <div className="flex min-h-[300px] items-center justify-center">
        <span className="text-sand-500">جاري تحميل القوالب...</span>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-sand-900">طلب جديد</h1>
        <p className="mt-1 text-sm text-sand-500">
          اختر قالب البيانات المطلوب وأدخل المعايير لبدء عملية الجمع الآلي
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Templates Selection (2 columns) */}
        <div className="space-y-4 lg:col-span-2">
          <h2 className="text-sm font-semibold text-sand-700">القوالب المتاحة</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {templates.map((tmpl) => {
              const isSelected = tmpl.slug === selectedSlug;
              return (
                <button
                  key={tmpl.slug}
                  type="button"
                  onClick={() => setSelectedSlug(tmpl.slug)}
                  className={`rounded-xl border p-5 text-right transition-all ${
                    isSelected
                      ? "border-accent bg-accent/5 ring-2 ring-accent/20"
                      : "border-sand-200 bg-white hover:border-sand-300"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-base font-bold text-sand-900">
                      {tmpl.nameAr}
                    </span>
                    <span className="rounded-full bg-sand-100 px-2.5 py-0.5 text-xs font-semibold text-sand-700">
                      {tmpl.priceCreditsPerUnit} رصيد
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-sand-600">
                    {tmpl.descriptionAr}
                  </p>
                </button>
              );
            })}
          </div>

          {/* Input Form for Selected Template */}
          {selectedTemplate && (
            <div className="mt-6 rounded-xl border border-sand-200 bg-white p-6">
              <h3 className="text-base font-semibold text-sand-900">
                مدخلات الطلب — {selectedTemplate.nameAr}
              </h3>

              <form onSubmit={handleSubmit} className="mt-5 space-y-5">
                {selectedTemplate.slug === "tiktok-profile" && (
                  <div>
                    <label
                      htmlFor="username"
                      className="block text-sm font-medium text-sand-700"
                    >
                      اسم المستخدم (TikTok Username)
                    </label>
                    <div className="mt-1 flex rounded-lg border border-sand-300 bg-white focus-within:border-accent">
                      <span className="flex items-center px-3 text-sand-400" dir="ltr">
                        @
                      </span>
                      <input
                        id="username"
                        type="text"
                        required
                        dir="ltr"
                        placeholder="e.g. khaby.lame"
                        value={params.username || ""}
                        onChange={(e) =>
                          setParams({ ...params, username: e.target.value.replace(/^@/, "").trim() })
                        }
                        className="w-full rounded-r-lg border-0 py-2.5 text-sand-900 placeholder:text-sand-400 focus:outline-none focus:ring-0"
                      />
                    </div>
                    <p className="mt-1 text-xs text-sand-500">
                      أدخل اسم المستخدم للحساب العام المراد استرجاع إحصائياته وملفه
                    </p>
                  </div>
                )}

                {error && (
                  <div className="rounded-lg bg-red-50 p-4 text-sm text-danger">
                    {error}
                  </div>
                )}

                {success && (
                  <div className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-700">
                    {success}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || hasInsufficientBalance}
                  className="w-full rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {loading ? "جاري إنشاء الطلب وحجز الرصيد..." : `بدء الطلب (${requiredCredits} رصيد)`}
                </button>
              </form>
            </div>
          )}
        </div>

        {/* Order Summary & Balance (1 column) */}
        <div className="space-y-6">
          <div className="rounded-xl border border-sand-200 bg-white p-6">
            <h2 className="text-sm font-semibold text-sand-700">ملخص الرصيد</h2>

            <div className="mt-4 flex items-center justify-between border-b border-sand-100 pb-3">
              <span className="text-sm text-sand-600">رصيدك المتاح:</span>
              <span className="font-bold text-sand-900">
                {userBalance !== null ? `${userBalance} رصيد` : "..."}
              </span>
            </div>

            <div className="mt-3 flex items-center justify-between border-b border-sand-100 pb-3">
              <span className="text-sm text-sand-600">تكلفة هذا الطلب:</span>
              <span className="font-bold text-accent">
                {requiredCredits} رصيد
              </span>
            </div>

            <div className="mt-3 flex items-center justify-between pt-1 text-sm font-medium">
              <span className="text-sand-700">الرصيد المتبقي بعد الحجز:</span>
              <span
                className={`font-bold ${
                  hasInsufficientBalance ? "text-danger" : "text-sand-900"
                }`}
              >
                {userBalance !== null ? `${userBalance - requiredCredits} رصيد` : "..."}
              </span>
            </div>

            {hasInsufficientBalance && (
              <div className="mt-4 rounded-lg bg-red-50 p-3 text-xs text-danger">
                رصيدك الحالي غير كافٍ. يرجى شحن الرصيد لتتمكن من إنشاء هذا الطلب.
                <div className="mt-2">
                  <Link
                    href="/dashboard/topup"
                    className="inline-block rounded bg-danger px-3 py-1 font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    شحن الرصيد الآن
                  </Link>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-sand-200 bg-sand-50 p-5 text-xs text-sand-600">
            <p className="font-semibold text-sand-800">ملاحظة أمان الرصيد:</p>
            <p className="mt-1 leading-relaxed">
              يتم حجز الرصيد مؤقتًا عند بدء الطلب، ولا يتم خصم التكلفة الفعلية إلا بعد نجاح استخراج البيانات. في حال فشل الطلب لأي سبب، يُلغى الحجز تلقائيًا ويعود الرصيد لحسابك بالكامل.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
