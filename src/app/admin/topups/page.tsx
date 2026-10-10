"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { client, databases } from "@/lib/appwrite";
import { Functions, Query, Storage } from "appwrite";

const functions = new Functions(client);
const storage = new Storage(client);

interface AdminTopup {
  $id: string;
  userId: string;
  amountEgp: number;
  confirmedAmountEgp?: number;
  credits?: number;
  reference: string;
  receiptFileId?: string;
  status: "pending" | "approved" | "rejected";
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
}

export default function AdminTopupsPage() {
  const [topups, setTopups] = useState<AdminTopup[]>([]);
  const [filter, setFilter] = useState<"all" | "pending" | "approved" | "rejected">("pending");
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const loadTopups = useCallback(async () => {
    setLoading(true);
    try {
      const queries = [Query.orderDesc("createdAt"), Query.limit(50)];
      if (filter !== "all") {
        queries.push(Query.equal("status", filter));
      }
      const res = await databases.listDocuments("digr", "topups", queries);
      setTopups(res.documents as unknown as AdminTopup[]);
    } catch (err: any) {
      setMessage(`خطأ في جلب البيانات: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadTopups();
  }, [loadTopups]);

  async function handleAction(topupId: string, action: "approve" | "reject", confirmedAmountEgp?: number) {
    setActionLoading(topupId);
    setMessage("");
    try {
      const execution = await functions.createExecution(
        "approve-topup",
        JSON.stringify({ topupId, action, confirmedAmountEgp }),
        false
      );

      const res = JSON.parse(execution.responseBody || "{}");
      if (!res.success) {
        throw new Error(res.error || "فشل تحديث الطلب");
      }

      setMessage(action === "approve" ? `تم اعتماد الطلب وإضافة ${res.credits} نقطة للمستخدم بنجاح ✓` : "تم رفض الطلب");
      loadTopups();
    } catch (err: any) {
      setMessage(err.message || "حدث خطأ أثناء تنفيذ الإجراء");
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 space-y-6 text-right">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-sand-200">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-amber-100 border border-amber-200 text-amber-900 px-2 py-0.5 text-xs font-bold">
              لوحة الإدارة
            </span>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-ink-900">
              مراجعة طلبات شحن Instapay
            </h1>
          </div>
          <p className="mt-1 text-xs sm:text-sm text-ink-500">
            تأكيد وصول الحوالات البنكية واعتماد رصيد النقاط بحركات قيود حتمية في credit_ledger
          </p>
        </div>

        <Link
          href="/dashboard"
          className="touch-target inline-flex items-center justify-center rounded-xl border border-sand-300 bg-white px-4 py-2 text-xs font-medium text-ink-700 hover:bg-sand-50 transition-colors self-start sm:self-auto"
        >
          ← العودة للوحة التحكم
        </Link>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1 bg-sand-200/60 p-1 rounded-xl text-xs font-medium">
          <button
            onClick={() => setFilter("pending")}
            className={`touch-target px-3.5 py-1.5 rounded-lg transition-colors ${
              filter === "pending" ? "bg-white text-ink-900 font-bold shadow-2xs" : "text-ink-600 hover:text-ink-900"
            }`}
          >
            المعلقة
          </button>
          <button
            onClick={() => setFilter("approved")}
            className={`touch-target px-3.5 py-1.5 rounded-lg transition-colors ${
              filter === "approved" ? "bg-white text-ink-900 font-bold shadow-2xs" : "text-ink-600 hover:text-ink-900"
            }`}
          >
            المعتمدة
          </button>
          <button
            onClick={() => setFilter("rejected")}
            className={`touch-target px-3.5 py-1.5 rounded-lg transition-colors ${
              filter === "rejected" ? "bg-white text-ink-900 font-bold shadow-2xs" : "text-ink-600 hover:text-ink-900"
            }`}
          >
            المرفوضة
          </button>
          <button
            onClick={() => setFilter("all")}
            className={`touch-target px-3.5 py-1.5 rounded-lg transition-colors ${
              filter === "all" ? "bg-white text-ink-900 font-bold shadow-2xs" : "text-ink-600 hover:text-ink-900"
            }`}
          >
            الكل
          </button>
        </div>

        <button
          onClick={loadTopups}
          className="touch-target text-xs text-ink-500 hover:text-ink-900 font-medium"
        >
          تحديث السجل ⟳
        </button>
      </div>

      {message && (
        <div className="rounded-xl bg-blue-50 border border-blue-200 p-3.5 text-xs text-blue-900">
          {message}
        </div>
      )}

      {/* Table */}
      <div className="rounded-2xl border border-sand-200 bg-white shadow-2xs overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-xs text-ink-400">جاري تحميل طلبات الشحن...</div>
        ) : topups.length === 0 ? (
          <div className="p-12 text-center text-xs text-ink-400">لا توجد طلبات في هذا القسم حالياً.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-sand-50 border-b border-sand-200 text-ink-500 font-medium">
                <tr>
                  <th className="p-3.5">التاريخ</th>
                  <th className="p-3.5">معرف العميل</th>
                  <th className="p-3.5">المبلغ</th>
                  <th className="p-3.5">الرقم المرجعي</th>
                  <th className="p-3.5">الإيصال</th>
                  <th className="p-3.5">الحالة</th>
                  <th className="p-3.5 text-center">الإجراء الإداري</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-100 font-mono text-ink-800">
                {topups.map((t) => (
                  <tr key={t.$id} className="hover:bg-sand-50/50">
                    <td className="p-3.5 text-ink-500" dir="ltr">
                      {new Date(t.createdAt).toLocaleString("ar-EG", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="p-3.5 text-ink-600" dir="ltr">
                      {t.userId.substring(0, 10)}...
                    </td>
                    <td className="p-3.5 font-bold text-ink-900">{t.amountEgp} ج.م</td>
                    <td className="p-3.5 text-ink-700" dir="ltr">
                      {t.reference}
                    </td>
                    <td className="p-3.5 font-sans">
                      {t.receiptFileId ? (
                        <a
                          href={storage.getFileView("receipts", t.receiptFileId).toString()}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-accent hover:underline font-semibold"
                        >
                          عرض الإيصال ↗
                        </a>
                      ) : (
                        <span className="text-sand-400">بدون إيصال</span>
                      )}
                    </td>
                    <td className="p-3.5 font-sans">
                      {t.status === "approved" && (
                        <span className="rounded-full bg-emerald-50 text-emerald-800 px-2.5 py-0.5 text-[10px] font-semibold">
                          معتمد (+{t.credits} نقطة)
                        </span>
                      )}
                      {t.status === "pending" && (
                        <span className="rounded-full bg-amber-50 text-amber-800 px-2.5 py-0.5 text-[10px] font-semibold">
                          معلق قيد المراجعة
                        </span>
                      )}
                      {t.status === "rejected" && (
                        <span className="rounded-full bg-red-50 text-danger px-2.5 py-0.5 text-[10px] font-semibold">
                          مرفوض
                        </span>
                      )}
                    </td>
                    <td className="p-3.5 text-center font-sans">
                      {t.status === "pending" ? (
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => handleAction(t.$id, "approve")}
                            disabled={actionLoading === t.$id}
                            className="touch-target rounded-lg bg-emerald-800 hover:bg-emerald-900 text-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50 transition-colors"
                          >
                            {actionLoading === t.$id ? "..." : "اعتماد ✓"}
                          </button>
                          <button
                            onClick={() => handleAction(t.$id, "reject")}
                            disabled={actionLoading === t.$id}
                            className="touch-target rounded-lg bg-rose-800 hover:bg-rose-900 text-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50 transition-colors"
                          >
                            {actionLoading === t.$id ? "..." : "رفض ✕"}
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-ink-400 font-sans">تمت المعالجة</span>
                      )}
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
