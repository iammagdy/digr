"use client";

import { useState, useEffect, useCallback, type FormEvent } from "react";
import { client, databases } from "@/lib/appwrite";
import { useUser } from "@/hooks/useUser";
import { Storage, Functions, ID, Permission, Role, Query } from "appwrite";
import { Alert, Badge, Button, Card, EmptyState, Eyebrow, Field, Input, Skeleton, type StatusTone } from "@/components/ui";

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

const LEDGER_TYPE: Record<string, { label: string; tone: StatusTone }> = {
  topup: { label: "شحن رصيد", tone: "success" },
  reserve: { label: "حجز مؤقت", tone: "warning" },
  release: { label: "استرداد حجز", tone: "info" },
  charge: { label: "خصم التسليم", tone: "danger" },
  adjust: { label: "تسوية إدارية", tone: "neutral" },
};

const TOPUP_STATUS: Record<TopupRecord["status"], { label: string; tone: StatusTone }> = {
  approved: { label: "معتمد", tone: "success" },
  pending: { label: "قيد المراجعة", tone: "warning" },
  rejected: { label: "مرفوض", tone: "danger" },
};

export default function TopupPage() {
  const { user } = useUser();
  const [amountEgp, setAmountEgp] = useState<number>(100);
  const [reference, setReference] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [creditRate, setCreditRate] = useState<number>(0.1);
  const [userBalance, setUserBalance] = useState<number | null>(null);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [history, setHistory] = useState<TopupRecord[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [copiedHandle, setCopiedHandle] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

  const instapayHandle = process.env.NEXT_PUBLIC_INSTAPAY_HANDLE || "digr@instapay";
  const instapayPhone = process.env.NEXT_PUBLIC_INSTAPAY_PHONE || "01000000000";

  useEffect(() => {
    async function loadRate() {
      try {
        const doc: any = await databases.getDocument("digr", "settings_public", "pricing");
        if (doc?.creditValueEgp) setCreditRate(doc.creditValueEgp);
      } catch { /* fallback default */ }
    }
    loadRate();
  }, []);

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
        for (const doc of res.documents) total += (doc.delta as number) || 0;
        if (res.documents.length < limit) break;
        offset += limit;
      }
      setUserBalance(total);
      let running = 0;
      const computed: LedgerEntry[] = allDocs.map((doc) => {
        running += (doc.delta as number) || 0;
        return { $id: doc.$id, type: doc.type, delta: doc.delta, reference: doc.reference, createdAt: doc.createdAt, runningBalance: running };
      });
      setLedgerEntries(computed.reverse().slice(0, 30));
    } catch {
      setUserBalance(0);
    } finally {
      setDataLoading(false);
    }
  }, [user]);

  const loadHistory = useCallback(async () => {
    if (!user) return;
    try {
      const res = await databases.listDocuments("digr", "topups", [
        Query.equal("userId", user.$id),
        Query.orderDesc("createdAt"),
        Query.limit(20),
      ]);
      setHistory(res.documents as unknown as TopupRecord[]);
    } catch { /* no topups yet */ }
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
      if (file) {
        if (file.size > 5 * 1024 * 1024) throw new Error("حجم الإيصال يجب ألا يتجاوز 5 ميجابايت");
        const allowed = ["image/png", "image/jpeg", "image/jpg", "application/pdf"];
        if (!allowed.includes(file.type)) throw new Error("صيغة الملف غير مدعومة. الصيغ المسموحة: PNG, JPG, PDF");
        const uploaded = await storage.createFile(
          "receipts",
          ID.unique(),
          file,
          user ? [Permission.read(Role.user(user.$id))] : []
        );
        receiptFileId = uploaded.$id;
      }
      const execution = await functions.createExecution(
        "submit-topup",
        JSON.stringify({ amountEgp: Number(amountEgp), reference: reference.trim(), receiptFileId }),
        false
      );
      const res = JSON.parse(execution.responseBody || "{}");
      if (!res.success) throw new Error(res.error || "فشل إرسال طلب الشحن");
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

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6">
      <div>
        <Eyebrow>المحفظة</Eyebrow>
        <h1 className="font-display mt-2 text-3xl text-ink-900">الرصيد والشحن</h1>
        <p className="mt-1.5 text-sm text-ink-600">كل حركة في محفظتك مسجّلة في سجل مالي غير قابل للتعديل.</p>
      </div>

      {/* Wallet hero */}
      <div className="relative overflow-hidden rounded-3xl bg-pine-950 p-6 text-white shadow-[var(--shadow-lift)] sm:p-8">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div className="absolute -top-24 -start-24 h-64 w-64 rounded-full bg-accent/20 blur-3xl" />
        </div>
        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold text-sand-300">رصيد النقاط المتاح</p>
            {dataLoading ? (
              <Skeleton className="mt-2 h-11 w-40 !bg-white/10" />
            ) : (
              <p className="tnum mt-1.5 text-4xl font-bold sm:text-5xl">
                {(userBalance ?? 0).toLocaleString("ar-EG")} <span className="text-lg font-bold text-amber-points">نقطة</span>
              </p>
            )}
            <p className="tnum mt-2 text-sm text-sand-300">
              ≈ {((userBalance ?? 0) * creditRate).toFixed(2)} ج.م · السعر المعتمد: 1 نقطة = {creditRate} ج.م
            </p>
          </div>
          <a href="#topup-card" className="inline-flex min-h-12 shrink-0 items-center justify-center rounded-2xl bg-amber-points px-6 py-3 text-sm font-bold text-white transition-colors hover:bg-amber-points-hover">
            شحن المحفظة
          </a>
        </div>
        <div className="relative mt-6 grid grid-cols-3 gap-3 border-t border-white/10 pt-5 text-center">
          {[
            ["حجز مؤقت", "يُحجز عند موافقتك على خطة"],
            ["خصم نهائي", "فقط بعد تسليم السجلات"],
            ["استرداد", "أي فرق يعود تلقائيًا"],
          ].map(([t, d]) => (
            <div key={t}>
              <p className="text-xs font-bold text-white">{t}</p>
              <p className="mt-0.5 text-xs text-sand-400">{d}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Top-up grid */}
      <div id="topup-card" className="grid items-start gap-6 lg:grid-cols-12">
        <Card className="space-y-6 p-6 lg:col-span-7">
          <div>
            <h2 className="text-lg font-bold text-ink-900">طلب شحن جديد عبر Instapay</h2>
            <p className="mt-1 text-xs text-sand-600">اختر المبلغ أو أدخله، ثم حوّل من تطبيق انستاباي وسجّل رقم العملية المرجعي.</p>
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          {success && <Alert tone="success">{success}</Alert>}
          <form onSubmit={handleSubmit} className="space-y-5">
            <fieldset>
              <legend className="mb-2 block text-xs font-bold text-ink-800">المبالغ المقترحة</legend>
              <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="المبالغ المقترحة">
                {PRESET_AMOUNTS.map((p) => {
                  const selected = amountEgp === p.egp;
                  return (
                    <button
                      key={p.egp}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setAmountEgp(p.egp)}
                      className={`touch-target rounded-2xl border p-2.5 text-center transition-all cursor-pointer ${selected ? "border-accent bg-accent-light/60 ring-1 ring-accent/30" : "border-sand-200 bg-white hover:border-sand-400"}`}
                    >
                      <span className="tnum block text-xs font-bold text-ink-900">{p.label}</span>
                      <span className="tnum mt-0.5 block text-xs font-bold text-amber-points">{p.points.toLocaleString("ar-EG")} نقطة</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <Field label="المبلغ بالجنيه المصري" htmlFor="amount" hint={`يعطيك هذا المبلغ: ${estimatedCredits.toLocaleString("ar-EG")} نقطة`}>
              <Input id="amount" type="number" min={10} step={5} required dir="ltr" value={amountEgp} onChange={(e) => setAmountEgp(Number(e.target.value))} className="tnum text-left font-mono" />
            </Field>
            <Field label="رقم العملية المرجعي" htmlFor="ref" hint="يظهر في إشعار تأكيد التحويل داخل تطبيق انستاباي.">
              <Input id="ref" type="text" required dir="ltr" placeholder="مثال: 418290384729" value={reference} onChange={(e) => setReference(e.target.value)} className="text-left font-mono" />
            </Field>
            <Field label="صورة إيصال التحويل (اختياري)" htmlFor="receipt" hint="PNG أو JPG أو PDF — بحد أقصى 5 ميجابايت.">
              <Input
                id="receipt"
                type="file"
                accept="image/png,image/jpeg,image/jpg,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="text-xs file:me-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-sand-100 file:px-3 file:py-2 file:text-xs file:font-bold file:text-ink-800 hover:file:bg-sand-200"
              />
            </Field>
            <Button type="submit" size="lg" variant="accent" className="w-full" disabled={loading}>
              {loading ? "جاري إرسال الطلب..." : "تأكيد وإرسال طلب الشحن"}
            </Button>
          </form>
        </Card>

        <Card className="space-y-5 bg-sand-50/50 p-6 lg:col-span-5">
          <div>
            <h3 className="text-sm font-bold text-ink-900">بيانات التحويل عبر Instapay</h3>
            <p className="mt-1 text-xs text-sand-600">انسخ البيانات التالية لاستخدامها في تطبيق انستاباي.</p>
          </div>
          {[
            { label: "عنوان الدفع اللحظي (IPA)", value: instapayHandle, copied: copiedHandle, type: "handle" as const },
            { label: "أو عبر رقم الهاتف", value: instapayPhone, copied: copiedPhone, type: "phone" as const },
          ].map((row) => (
            <div key={row.label} className="rounded-2xl border border-sand-200 bg-white p-4">
              <p className="text-xs text-sand-500">{row.label}</p>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="tnum font-mono text-sm font-bold text-ink-900" dir="ltr">{row.value}</span>
                <Button size="sm" variant="secondary" onClick={() => handleCopy(row.value, row.type)}>
                  {row.copied ? "تم النسخ ✓" : "نسخ"}
                </Button>
              </div>
            </div>
          ))}
          <div className="rounded-2xl border border-sand-200 bg-white p-4">
            <p className="text-xs text-sand-500">اسم المستلم</p>
            <p className="mt-1 text-sm font-bold text-ink-900">منصة Digr</p>
          </div>
          <Alert tone="info">
            بعد التحويل، يراجع فريق الإدارة الرقم المرجعي ويعتمد الرصيد في محفظتك.
          </Alert>
        </Card>
      </div>

      {/* Ledger */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-sand-100 p-5">
          <h2 className="text-base font-bold text-ink-900">سجل حركات المحفظة</h2>
          <span className="tnum text-xs text-sand-500">آخر 30 حركة</span>
        </div>
        {dataLoading ? (
          <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : ledgerEntries.length === 0 ? (
          <EmptyState title="لا توجد حركات بعد" description="ستظهر هنا كل عمليات الشحن والحجز والخصم والاسترداد." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-sand-100 bg-sand-50/60 text-sand-600">
                  <th scope="col" className="px-4 py-3 font-semibold">التاريخ</th>
                  <th scope="col" className="px-4 py-3 font-semibold">نوع الحركة</th>
                  <th scope="col" className="px-4 py-3 font-semibold">التغيّر</th>
                  <th scope="col" className="px-4 py-3 font-semibold">الرصيد بعدها</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-100">
                {ledgerEntries.map((entry) => {
                  const meta = LEDGER_TYPE[entry.type] ?? { label: entry.type, tone: "neutral" as StatusTone };
                  const positive = entry.delta > 0;
                  return (
                    <tr key={entry.$id} className="transition-colors hover:bg-sand-50/60">
                      <td className="tnum whitespace-nowrap px-4 py-3 text-sand-500">
                        {new Date(entry.createdAt).toLocaleString("ar-EG", { dateStyle: "short", timeStyle: "short" })}
                      </td>
                      <td className="px-4 py-3"><Badge tone={meta.tone}>{meta.label}</Badge></td>
                      <td className={`tnum whitespace-nowrap px-4 py-3 font-bold ${positive ? "text-success" : "text-danger"}`} dir="ltr">
                        {positive ? `+${entry.delta}` : entry.delta}
                      </td>
                      <td className="tnum whitespace-nowrap px-4 py-3 font-semibold text-ink-900">
                        {entry.runningBalance !== undefined ? `${entry.runningBalance.toLocaleString("ar-EG")} نقطة` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Top-up history */}
      <Card className="overflow-hidden">
        <div className="border-b border-sand-100 p-5">
          <h2 className="text-base font-bold text-ink-900">طلبات الشحن السابقة</h2>
        </div>
        {history.length === 0 ? (
          <EmptyState title="لا توجد طلبات شحن" description="عند إرسالك طلب شحن سيظهر هنا مع حالته." />
        ) : (
          <ul className="divide-y divide-sand-100">
            {history.map((item) => {
              const st = TOPUP_STATUS[item.status];
              return (
                <li key={item.$id} className="flex flex-wrap items-center gap-3 p-4 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <p className="tnum text-sm font-bold text-ink-900">
                      {item.amountEgp} ج.م
                      {item.credits ? <span className="text-amber-points"> · +{item.credits.toLocaleString("ar-EG")} نقطة</span> : null}
                    </p>
                    <p className="tnum mt-0.5 text-xs text-sand-500" dir="ltr">
                      {item.reference} · {new Date(item.createdAt).toLocaleDateString("ar-EG")}
                    </p>
                  </div>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
