"use client";

import { useState, useEffect, useCallback } from "react";
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

      setMessage(action === "approve" ? `تم اعتماد الطلب وإضافة ${res.credits} رصيد للمستخدم بنجاح` : "تم رفض الطلب");
      loadTopups();
    } catch (err: any) {
      setMessage(err.message || "حدث خطأ أثناء تنفيذ الإجراء");
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-sand-900">مراجعة طلبات الشحن</h1>
          <p className="mt-1 text-sm text-sand-500">
            تأكيد التحويلات البنكية وإضافة الرصيد للعملاء عبر المعرّف الحتمي
          </p>
        </div>

        {/* Filters */}
        <div className="flex rounded-lg border border-sand-200 bg-white p-1 text-xs">
          <button
            onClick={() => setFilter("pending")}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
              filter === "pending" ? "bg-accent text-white" : "text-sand-600 hover:text-sand-900"
            }`}
          >
            المعلقة
          </button>
          <button
            onClick={() => setFilter("approved")}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
              filter === "approved" ? "bg-accent text-white" : "text-sand-600 hover:text-sand-900"
            }`}
          >
            المعتمدة
          </button>
          <button
            onClick={() => setFilter("rejected")}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
              filter === "rejected" ? "bg-accent text-white" : "text-sand-600 hover:text-sand-900"
            }`}
          >
            المرفوضة
          </button>
          <button
            onClick={() => setFilter("all")}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
              filter === "all" ? "bg-accent text-white" : "text-sand-600 hover:text-sand-900"
            }`}
          >
            الكل
          </button>
        </div>
      </div>

      {message && (
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm text-accent">
          {message}
        </div>
      )}

      <div className="rounded-xl border border-sand-200 bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-sm text-sand-400">جاري تحميل الطلبات...</div>
        ) : topups.length === 0 ? (
          <div className="p-12 text-center text-sm text-sand-400">لا توجد طلبات شحن في هذا القسم</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-sm">
              <thead className="bg-sand-50 border-b border-sand-200 text-xs text-sand-500 font-medium">
                <tr>
                  <th className="py-3.5 px-4">التاريخ</th>
                  <th className="py-3.5 px-4">المستخدم</th>
                  <th className="py-3.5 px-4">المبلغ</th>
                  <th className="py-3.5 px-4">المرجع</th>
                  <th className="py-3.5 px-4">الإيصال</th>
                  <th className="py-3.5 px-4">الحالة</th>
                  <th className="py-3.5 px-4 text-center">الإجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-100">
                {topups.map((t) => (
                  <tr key={t.$id} className="hover:bg-sand-50/50 transition-colors">
                    <td className="py-4 px-4 font-mono text-xs text-sand-500" dir="ltr">
                      {new Date(t.createdAt).toLocaleString("ar-EG")}
                    </td>
                    <td className="py-4 px-4 font-mono text-xs text-sand-600" dir="ltr">
                      {t.userId.substring(0, 8)}...
                    </td>
                    <td className="py-4 px-4 font-bold text-sand-900">
                      {t.amountEgp} ج.م
                    </td>
                    <td className="py-4 px-4 font-mono text-xs text-sand-700" dir="ltr">
                      {t.reference}
                    </td>
                    <td className="py-4 px-4">
                      {t.receiptFileId ? (
                        <a
                          href={storage.getFileView("receipts", t.receiptFileId).toString()}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-accent hover:underline font-medium"
                        >
                          عرض الإيصال ↗
                        </a>
                      ) : (
                        <span className="text-xs text-sand-400">بدون إيصال</span>
                      )}
                    </td>
                    <td className="py-4 px-4">
                      {t.status === "approved" && (
                        <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-success">
                          معتمد ({t.credits} رصيد)
                        </span>
                      )}
                      {t.status === "pending" && (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-warning">
                          معلق
                        </span>
                      )}
                      {t.status === "rejected" && (
                        <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-danger">
                          مرفوض
                        </span>
                      )}
                    </td>
                    <td className="py-4 px-4 text-center">
                      {t.status === "pending" ? (
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => handleAction(t.$id, "approve")}
                            disabled={actionLoading === t.$id}
                            className="rounded-md bg-success px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 transition-colors disabled:opacity-50"
                          >
                            {actionLoading === t.$id ? "..." : "اعتماد"}
                          </button>
                          <button
                            onClick={() => handleAction(t.$id, "reject")}
                            disabled={actionLoading === t.$id}
                            className="rounded-md bg-danger px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                          >
                            {actionLoading === t.$id ? "..." : "رفض"}
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-sand-400">مكتمل</span>
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
