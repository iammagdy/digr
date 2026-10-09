"use client";

import { useState, useEffect, useCallback, type FormEvent } from "react";
import { client, databases } from "@/lib/appwrite";
import { useUser } from "@/hooks/useUser";
import { Storage, Functions, ID, Permission, Role, Query } from "appwrite";

const storage = new Storage(client);
const functions = new Functions(client);

interface TopupRecord {
  $id: string;
  amountEgp: number;
  credits?: number;
  reference: string;
  receiptFileId?: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

export default function TopupPage() {
  const { user } = useUser();
  const [amountEgp, setAmountEgp] = useState<number>(100);
  const [reference, setReference] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [creditRate, setCreditRate] = useState<number>(0.1); // default 0.1 EGP per credit

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [history, setHistory] = useState<TopupRecord[]>([]);

  // Load public credit rate
  useEffect(() => {
    async function loadRate() {
      try {
        const doc: any = await databases.getDocument("digr", "settings_public", "pricing");
        if (doc?.creditValueEgp) setCreditRate(doc.creditValueEgp);
      } catch {
        // Fallback default
      }
    }
    loadRate();
  }, []);

  // Load past topups
  const loadHistory = useCallback(async () => {
    if (!user) return;
    try {
      const res = await databases.listDocuments("digr", "topups", [
        Query.orderDesc("createdAt"),
        Query.limit(20),
      ]);
      setHistory(res.documents as unknown as TopupRecord[]);
    } catch {
      // User might have no topups yet or collection initializing
    }
  }, [user]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!amountEgp || amountEgp <= 0) {
      setError("يرجى إدخال مبلغ صحيح");
      return;
    }
    if (!reference.trim()) {
      setError("يرجى إدخال رقم العملية المرجعي من تطبيق انستاباي");
      return;
    }

    setLoading(true);
    try {
      let receiptFileId: string | undefined = undefined;

      // 1. Upload receipt if selected
      if (file) {
        if (file.size > 5 * 1024 * 1024) {
          throw new Error("حجم الإيصال يجب ألا يتجاوز 5 ميجابايت");
        }
        const allowed = ["image/png", "image/jpeg", "image/jpg", "application/pdf"];
        if (!allowed.includes(file.type)) {
          throw new Error("صيغة الملف غير مدعومة. الصيغ المسموحة: PNG, JPG, PDF");
        }

        const uploaded = await storage.createFile(
          "receipts",
          ID.unique(),
          file,
          user ? [Permission.read(Role.user(user.$id))] : []
        );
        receiptFileId = uploaded.$id;
      }

      // 2. Submit topup via Function (forces status=pending, caller=userId)
      const execution = await functions.createExecution(
        "submit-topup",
        JSON.stringify({
          amountEgp: Number(amountEgp),
          reference: reference.trim(),
          receiptFileId,
        }),
        false // Synchronous execution
      );

      const res = JSON.parse(execution.responseBody || "{}");
      if (!res.success) {
        throw new Error(res.error || "فشل إرسال طلب الشحن");
      }

      setSuccess("تم إرسال طلب الشحن بنجاح! سيتم مراجعته وإضافة الرصيد لحسابك خلال دقائق.");
      setReference("");
      setFile(null);
      loadHistory();
    } catch (err: any) {
      setError(err.message || "حدث خطأ غير متوقع");
    } finally {
      setLoading(false);
    }
  }

  const estimatedCredits = Math.floor(amountEgp / creditRate);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-sand-900">شحن الرصيد عبر Instapay</h1>
        <p className="mt-1 text-sm text-sand-500">
          حوّل المبلغ المطلوب، وأدخل رقم العملية المرجعي لتأكيد الشحن
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Form Card */}
        <div className="rounded-xl border border-sand-200 bg-white p-6 lg:col-span-2">
          <h2 className="text-lg font-semibold text-sand-900">طلب شحن جديد</h2>

          {error && (
            <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-danger">
              {error}
            </div>
          )}
          {success && (
            <div className="mt-4 rounded-lg bg-green-50 p-3 text-sm text-success">
              {success}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            <div>
              <label htmlFor="amount" className="block text-sm font-medium text-sand-700">
                المبلغ بالجنيه المصري (EGP)
              </label>
              <div className="relative mt-1">
                <input
                  id="amount"
                  type="number"
                  min="10"
                  step="10"
                  required
                  dir="ltr"
                  className="w-full rounded-lg border border-sand-300 bg-white px-4 py-2.5 text-sand-900 focus:border-accent"
                  value={amountEgp}
                  onChange={(e) => setAmountEgp(Number(e.target.value))}
                />
              </div>
              <p className="mt-1 text-xs text-sand-500">
                المبلغ سيعطيك تقريباً: <strong className="font-semibold text-accent">{estimatedCredits.toLocaleString("ar-EG")} رصيد</strong> (سعر الرصيد: {creditRate} ج.م)
              </p>
            </div>

            <div>
              <label htmlFor="ref" className="block text-sm font-medium text-sand-700">
                رقم العملية المرجعي (Reference No.)
              </label>
              <input
                id="ref"
                type="text"
                required
                dir="ltr"
                placeholder="مثال: 123456789012"
                className="mt-1 w-full rounded-lg border border-sand-300 bg-white px-4 py-2.5 text-sand-900 focus:border-accent"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
              <p className="mt-1 text-xs text-sand-400">
                تجد رقم العملية في إشعار التحويل داخل تطبيق انستاباي
              </p>
            </div>

            <div>
              <label htmlFor="receipt" className="block text-sm font-medium text-sand-700">
                صورة الإيصال (اختياري، يسرّع الاعتماد)
              </label>
              <input
                id="receipt"
                type="file"
                accept="image/png,image/jpeg,image/jpg,application/pdf"
                className="mt-1 block w-full text-xs text-sand-500 file:ml-4 file:rounded-md file:border-0 file:bg-sand-100 file:px-4 file:py-2 file:text-xs file:font-medium file:text-sand-700 hover:file:bg-sand-200"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
              <p className="mt-1 text-xs text-sand-400">
                PNG, JPG, PDF بحد أقصى 5 ميجابايت
              </p>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-accent px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {loading ? "جاري الإرسال..." : "إرسال طلب الشحن"}
            </button>
          </form>
        </div>

        {/* Instapay Instructions Sidebar */}
        <div className="space-y-4">
          <div className="rounded-xl border border-sand-200 bg-sand-100/50 p-6">
            <h3 className="font-semibold text-sand-900">بيانات التحويل</h3>
            <div className="mt-4 space-y-3 text-sm">
              <div>
                <span className="text-xs text-sand-500">عنوان الدفع (IPA):</span>
                <p className="font-mono font-medium text-sand-800" dir="ltr">
                  digr@instapay
                </p>
              </div>
              <div>
                <span className="text-xs text-sand-500">رقم الهاتف:</span>
                <p className="font-mono font-medium text-sand-800" dir="ltr">
                  01000000000
                </p>
              </div>
              <div>
                <span className="text-xs text-sand-500">اسم المستلم:</span>
                <p className="font-medium text-sand-800">منصة Digr</p>
              </div>
            </div>

            <div className="mt-5 border-t border-sand-200 pt-4 text-xs leading-relaxed text-sand-500">
              💡 بعد التحويل، انسخ رقم العملية وضعه في النموذج هنا. يتم اعتماد الرصيد يدوياً من قبل الإدارة بعد التأكد من وصول الحوالة.
            </div>
          </div>
        </div>
      </div>

      {/* History Table */}
      <div className="rounded-xl border border-sand-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-sand-900">سجل طلبات الشحن</h2>

        {history.length === 0 ? (
          <p className="mt-4 text-sm text-sand-400">لا توجد طلبات شحن سابقة</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-right text-sm">
              <thead>
                <tr className="border-b border-sand-200 text-xs text-sand-400">
                  <th className="pb-3 font-medium">التاريخ</th>
                  <th className="pb-3 font-medium">المبلغ</th>
                  <th className="pb-3 font-medium">الرصيد المضاف</th>
                  <th className="pb-3 font-medium">رقم المرجع</th>
                  <th className="pb-3 font-medium">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-100">
                {history.map((item) => (
                  <tr key={item.$id} className="text-sand-700">
                    <td className="py-3 font-mono text-xs" dir="ltr">
                      {new Date(item.createdAt).toLocaleDateString("ar-EG")}
                    </td>
                    <td className="py-3 font-medium">{item.amountEgp} ج.م</td>
                    <td className="py-3 font-bold text-accent">
                      {item.credits ? `+${item.credits.toLocaleString("ar-EG")}` : "—"}
                    </td>
                    <td className="py-3 font-mono text-xs" dir="ltr">
                      {item.reference}
                    </td>
                    <td className="py-3">
                      {item.status === "approved" && (
                        <span className="rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-success">
                          معتمد ✓
                        </span>
                      )}
                      {item.status === "pending" && (
                        <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-warning">
                          قيد المراجعة ⏳
                        </span>
                      )}
                      {item.status === "rejected" && (
                        <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-medium text-danger">
                          مرفوض ✕
                        </span>
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
