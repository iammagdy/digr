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

interface LedgerEntry {
  $id: string;
  type: string;
  delta: number;
  reference?: string;
  createdAt: string;
  runningBalance?: number;
}

const PRESET_AMOUNTS = [
  { egp: 50, label: "50 ج.م", points: 500 },
  { egp: 100, label: "100 ج.م", points: 1000 },
  { egp: 250, label: "250 ج.م", points: 2500 },
  { egp: 500, label: "500 ج.م", points: 5000 },
];

export default function TopupPage() {
  const { user } = useUser();
  const [amountEgp, setAmountEgp] = useState<number>(100);
  const [reference, setReference] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [creditRate, setCreditRate] = useState<number>(0.1); // 0.1 EGP per point (10 pts / EGP)
  const [userBalance, setUserBalance] = useState<number | null>(null);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [history, setHistory] = useState<TopupRecord[]>([]);

  // Copy status indicators
  const [copiedHandle, setCopiedHandle] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

  const instapayHandle = process.env.NEXT_PUBLIC_INSTAPAY_HANDLE || "digr@instapay";
  const instapayPhone = process.env.NEXT_PUBLIC_INSTAPAY_PHONE || "01000000000";

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

  // Load Balance & Full Ledger Entries
  const loadLedgerAndBalance = useCallback(async () => {
    if (!user) return;
    try {
      let total = 0;
      let offset = 0;
      const limit = 100;
      const allDocs: any[] = [];

      while (true) {
        const res = await databases.listDocuments("digr", "credit_ledger", [
          Query.equal("userId", user.$id),
          Query.orderAsc("createdAt"),
          Query.limit(limit),
          Query.offset(offset),
        ]);
        allDocs.push(...res.documents);
        for (const doc of res.documents) {
          total += (doc.delta as number) || 0;
        }
        if (res.documents.length < limit) break;
        offset += limit;
      }

      setUserBalance(total);

      // Compute running balance for each entry in chronological order, then reverse for display
      let currentRunning = 0;
      const computed: LedgerEntry[] = allDocs.map((doc) => {
        currentRunning += (doc.delta as number) || 0;
        return {
          $id: doc.$id,
          type: doc.type,
          delta: doc.delta,
          reference: doc.reference,
          createdAt: doc.createdAt,
          runningBalance: currentRunning,
        };
      });

      setLedgerEntries(computed.reverse().slice(0, 30));
    } catch {
      setUserBalance(0);
    }
  }, [user]);

  // Load past topup requests
  const loadHistory = useCallback(async () => {
    if (!user) return;
    try {
      const res = await databases.listDocuments("digr", "topups", [
        Query.equal("userId", user.$id),
        Query.orderDesc("createdAt"),
        Query.limit(20),
      ]);
      setHistory(res.documents as unknown as TopupRecord[]);
    } catch {
      // User might have no topups yet
    }
  }, [user]);

  useEffect(() => {
    loadLedgerAndBalance();
    loadHistory();
  }, [loadLedgerAndBalance, loadHistory]);

  const handleCopy = (text: string, type: "handle" | "phone") => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
      if (type === "handle") {
        setCopiedHandle(true);
        setTimeout(() => setCopiedHandle(false), 2000);
      } else {
        setCopiedPhone(true);
        setTimeout(() => setCopiedPhone(false), 2000);
      }
    }
  };

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

      // 1. Upload receipt if provided
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

      // 2. Submit topup via Function
      const execution = await functions.createExecution(
        "submit-topup",
        JSON.stringify({
          amountEgp: Number(amountEgp),
          reference: reference.trim(),
          receiptFileId,
        }),
        false
      );

      const res = JSON.parse(execution.responseBody || "{}");
      if (!res.success) {
        throw new Error(res.error || "فشل إرسال طلب الشحن");
      }

      setSuccess("تم تسجيل طلب الشحن بنجاح! سيتم مراجعته واعتماد النقاط لمحفظتك فور التحقق.");
      setReference("");
      setFile(null);
      loadHistory();
      loadLedgerAndBalance();
    } catch (err: any) {
      setError(err.message || "حدث خطأ غير متوقع");
    } finally {
      setLoading(false);
    }
  }

  const estimatedCredits = Math.floor(amountEgp / creditRate);

  const getLedgerTypeLabel = (type: string) => {
    switch (type) {
      case "topup":
        return { label: "شحن رصيد", badgeClass: "bg-emerald-50 text-emerald-800" };
      case "reserve":
        return { label: "حجز مؤقت للطلب", badgeClass: "bg-amber-50 text-amber-800" };
      case "release":
        return { label: "استرداد حجز", badgeClass: "bg-blue-50 text-blue-800" };
      case "charge":
        return { label: "خصم تكلفة التسليم", badgeClass: "bg-rose-50 text-rose-800" };
      case "adjust":
        return { label: "تسوية إدارية", badgeClass: "bg-sand-100 text-sand-800" };
      default:
        return { label: type, badgeClass: "bg-sand-100 text-ink-700" };
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 space-y-8 text-right">
      {/* Balance Summary Header Banner */}
      <div className="rounded-3xl border border-sand-300 bg-white p-6 sm:p-8 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="space-y-1">
            <span className="text-xs font-semibold text-ink-500">رصيد محفظتك المتاح</span>
            <div className="flex items-baseline gap-3">
              <span className="text-3xl sm:text-4xl font-bold tracking-tight text-ink-900 font-mono">
                {userBalance === null ? "..." : userBalance.toLocaleString("ar-EG")}
              </span>
              <span className="text-base sm:text-lg font-bold text-amber-points">نقطة</span>
              {userBalance !== null && (
                <span className="text-xs sm:text-sm font-medium text-ink-400 font-mono">
                  (تعادل {(userBalance * creditRate).toFixed(2)} جنيه مصري)
                </span>
              )}
            </div>
            <p className="text-xs text-ink-500 pt-1">
              سعر النقطة المعتمد: 1 نقطة = {creditRate} ج.م (10 جنيهات = 100 نقطة). لا اشتراكات شهرية، يخصم الرصيد فقط عند إتمام تسليم السجلات.
            </p>
          </div>

          <a
            href="#topup-card"
            className="touch-target inline-flex items-center justify-center rounded-xl bg-ink-900 px-5 py-3 text-sm font-semibold text-white hover:bg-ink-800 transition-all text-center self-start sm:self-auto"
          >
            شحن المحفظة الآن ↓
          </a>
        </div>
      </div>

      {/* Main Grid: Instapay Form & Details */}
      <div id="topup-card" className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Form Card */}
        <div className="lg:col-span-7 rounded-2xl border border-sand-200 bg-white p-6 shadow-2xs space-y-6">
          <div>
            <h2 className="text-lg font-bold text-ink-900">طلب شحن جديد عبر Instapay</h2>
            <p className="text-xs text-ink-500 mt-1">
              اختر المبلغ أو أدخله، ثم حوّل من تطبيق انستاباي وسجل رقم العملية المرجعي
            </p>
          </div>

          {error && <div className="rounded-xl bg-red-50 p-3 text-xs text-danger border border-red-200">{error}</div>}
          {success && (
            <div className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-800 border border-emerald-200">
              {success}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Preset Amount Pills */}
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-ink-700">المبالغ المقترحة:</label>
              <div className="grid grid-cols-4 gap-2">
                {PRESET_AMOUNTS.map((p) => (
                  <button
                    key={p.egp}
                    type="button"
                    onClick={() => setAmountEgp(p.egp)}
                    className={`touch-target rounded-xl border p-2.5 text-center transition-all ${
                      amountEgp === p.egp
                        ? "border-ink-900 bg-sand-100 text-ink-900 font-bold shadow-2xs"
                        : "border-sand-200 bg-sand-50/50 text-ink-700 hover:border-sand-300"
                    }`}
                  >
                    <span className="block text-xs font-mono">{p.label}</span>
                    <span className="block text-[10px] text-amber-points font-mono font-medium mt-0.5">
                      {p.points} نقطة
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Custom Amount Input */}
            <div>
              <label htmlFor="amount" className="block text-xs font-semibold text-ink-700">
                المبلغ بالجنيه المصري (EGP)
              </label>
              <input
                id="amount"
                type="number"
                min="10"
                step="5"
                required
                dir="ltr"
                className="mt-1 w-full rounded-xl border border-sand-300 bg-sand-50/50 px-4 py-2.5 text-sm font-mono text-ink-900 focus:bg-white focus:border-ink-900"
                value={amountEgp}
                onChange={(e) => setAmountEgp(Number(e.target.value))}
              />
              <span className="text-[11px] text-ink-500 mt-1 block">
                يعطيك هذا المبلغ: <strong className="text-ink-900 font-mono font-bold">{estimatedCredits.toLocaleString("ar-EG")} نقطة</strong>
              </span>
            </div>

            {/* Reference Number */}
            <div>
              <label htmlFor="ref" className="block text-xs font-semibold text-ink-700">
                رقم العملية المرجعي (Reference No.)
              </label>
              <input
                id="ref"
                type="text"
                required
                dir="ltr"
                placeholder="مثال: 418290384729"
                className="mt-1 w-full rounded-xl border border-sand-300 bg-sand-50/50 px-4 py-2.5 text-sm font-mono text-ink-900 focus:bg-white focus:border-ink-900"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
              <span className="text-[11px] text-ink-400 mt-1 block">
                الرقم المرجعي يظهر في إشعار تأكيد التحويل داخل تطبيق انستاباي
              </span>
            </div>

            {/* Receipt Upload */}
            <div>
              <label htmlFor="receipt" className="block text-xs font-semibold text-ink-700">
                صورة إيصال التحويل (اختياري)
              </label>
              <input
                id="receipt"
                type="file"
                accept="image/png,image/jpeg,image/jpg,application/pdf"
                className="mt-1 block w-full text-xs text-ink-500 file:ml-4 file:rounded-lg file:border-0 file:bg-sand-100 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-ink-800 hover:file:bg-sand-200"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
              <span className="text-[10px] text-ink-400 mt-0.5 block">
                الصيغ المقبولة: PNG, JPG, PDF بحد أقصى 5 ميجابايت
              </span>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="touch-target w-full rounded-xl bg-ink-900 px-5 py-3 text-sm font-semibold text-white hover:bg-ink-800 disabled:opacity-50 transition-all shadow-xs"
            >
              {loading ? "جاري إرسال الطلب..." : "تأكيد وإرسال طلب الشحن"}
            </button>
          </form>
        </div>

        {/* Instapay Transfer Details Card */}
        <div className="lg:col-span-5 rounded-2xl border border-sand-200 bg-sand-100/60 p-6 space-y-5">
          <div>
            <h3 className="text-sm font-bold text-ink-900">بيانات التحويل عبر Instapay</h3>
            <p className="text-xs text-ink-500 mt-1">
              حوّل القيمة من تطبيق انستاباي باستخدام أحد الخيارات التالية بنقرة زر واحدة للنسخ:
            </p>
          </div>

          <div className="space-y-3">
            {/* IPA Handle */}
            <div className="rounded-xl border border-sand-200 bg-white p-3.5 space-y-1">
              <span className="text-[11px] text-ink-400 font-medium block">عنوان الدفع اللحظي (IPA):</span>
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-bold text-ink-900" dir="ltr">
                  {instapayHandle}
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy(instapayHandle, "handle")}
                  className="touch-target rounded-lg bg-sand-100 hover:bg-sand-200 px-3 py-1.5 text-xs font-semibold text-ink-800 transition-colors"
                >
                  {copiedHandle ? "تم النسخ ✓" : "نسخ"}
                </button>
              </div>
            </div>

            {/* Phone Number */}
            <div className="rounded-xl border border-sand-200 bg-white p-3.5 space-y-1">
              <span className="text-[11px] text-ink-400 font-medium block">أو عبر رقم الهاتف:</span>
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-bold text-ink-900" dir="ltr">
                  {instapayPhone}
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy(instapayPhone, "phone")}
                  className="touch-target rounded-lg bg-sand-100 hover:bg-sand-200 px-3 py-1.5 text-xs font-semibold text-ink-800 transition-colors"
                >
                  {copiedPhone ? "تم النسخ ✓" : "نسخ"}
                </button>
              </div>
            </div>

            {/* Recipient Name */}
            <div className="rounded-xl border border-sand-200 bg-white p-3.5">
              <span className="text-[11px] text-ink-400 font-medium block">اسم المستلم في التطبيق:</span>
              <span className="text-sm font-bold text-ink-900 mt-0.5 block">منصة Digr</span>
            </div>
          </div>

          <div className="border-t border-sand-200 pt-3 text-xs leading-relaxed text-ink-600 flex items-start gap-1.5">
            <svg className="w-4 h-4 text-amber-points shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span><strong>آلية الاعتماد:</strong> فور استلام الحوالة، يتولى فريق الإدارة مراجعة الرقم المرجعي واعتماد الرصيد فورياً في محفظتك.</span>
          </div>
        </div>
      </div>

      {/* Transaction Ledger Table */}
      <div className="rounded-2xl border border-sand-200 bg-white p-6 shadow-2xs space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">سجل حركات المحفظة (Ledger)</h2>
          <span className="text-xs text-ink-400 font-mono">آخر 30 حركة</span>
        </div>

        {ledgerEntries.length === 0 ? (
          <p className="text-xs text-ink-400 py-6 text-center">لا توجد حركات مسجلة في محفظتك بعد.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-sand-100">
            <table className="w-full text-right text-xs">
              <thead className="bg-sand-50 border-b border-sand-200 text-ink-500 font-medium">
                <tr>
                  <th className="p-3">التاريخ</th>
                  <th className="p-3">نوع الحركة</th>
                  <th className="p-3">تغير النقاط</th>
                  <th className="p-3">الرصيد بعد الحركة</th>
                  <th className="p-3">المرجع</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-100 font-mono text-ink-800">
                {ledgerEntries.map((entry) => {
                  const typeInfo = getLedgerTypeLabel(entry.type);
                  const isPositive = entry.delta > 0;
                  return (
                    <tr key={entry.$id} className="hover:bg-sand-50/50">
                      <td className="p-3 text-ink-500" dir="ltr">
                        {new Date(entry.createdAt).toLocaleString("ar-EG", {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </td>
                      <td className="p-3">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold font-sans ${typeInfo.badgeClass}`}>
                          {typeInfo.label}
                        </span>
                      </td>
                      <td className={`p-3 font-bold ${isPositive ? "text-emerald-700" : "text-rose-700"}`}>
                        {isPositive ? `+${entry.delta}` : entry.delta}
                      </td>
                      <td className="p-3 font-semibold text-ink-900">
                        {entry.runningBalance !== undefined ? `${entry.runningBalance} نقطة` : "—"}
                      </td>
                      <td className="p-3 text-ink-400 text-[11px]" dir="ltr">
                        {entry.reference || entry.$id.slice(0, 14)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Past Top-up Requests Status */}
      <div className="rounded-2xl border border-sand-200 bg-white p-6 shadow-2xs space-y-4">
        <h2 className="text-base font-bold text-ink-900">طلبات الشحن السابقة</h2>

        {history.length === 0 ? (
          <p className="text-xs text-ink-400 py-6 text-center">لا توجد طلبات شحن سابقة.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-sand-100">
            <table className="w-full text-right text-xs">
              <thead className="bg-sand-50 border-b border-sand-200 text-ink-500 font-medium">
                <tr>
                  <th className="p-3">التاريخ</th>
                  <th className="p-3">المبلغ المحول</th>
                  <th className="p-3">الرصيد المكتسب</th>
                  <th className="p-3">الرقم المرجعي</th>
                  <th className="p-3">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-100 font-mono text-ink-800">
                {history.map((item) => (
                  <tr key={item.$id} className="hover:bg-sand-50/50">
                    <td className="p-3 text-ink-500" dir="ltr">
                      {new Date(item.createdAt).toLocaleDateString("ar-EG")}
                    </td>
                    <td className="p-3 font-semibold">{item.amountEgp} ج.م</td>
                    <td className="p-3 font-bold text-amber-points">
                      {item.credits ? `+${item.credits.toLocaleString("ar-EG")} نقطة` : "—"}
                    </td>
                    <td className="p-3 text-ink-500" dir="ltr">{item.reference}</td>
                    <td className="p-3">
                      {item.status === "approved" && (
                        <span className="rounded-full bg-emerald-50 text-emerald-800 px-2.5 py-0.5 text-[10px] font-semibold font-sans">
                          معتمد ✓
                        </span>
                      )}
                      {item.status === "pending" && (
                        <span className="rounded-full bg-amber-50 text-amber-800 px-2.5 py-0.5 text-[10px] font-semibold font-sans">
                          قيد المراجعة ⏳
                        </span>
                      )}
                      {item.status === "rejected" && (
                        <span className="rounded-full bg-red-50 text-danger px-2.5 py-0.5 text-[10px] font-semibold font-sans">
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
