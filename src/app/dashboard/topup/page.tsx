"use client";

import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { client, databases } from "@/lib/appwrite";
import { useUser } from "@/hooks/useUser";
import { Storage, Functions, ID, Permission, Role, Query } from "appwrite";
import { Alert, Badge, Button, Card, EmptyState, Eyebrow, Field, Input, Skeleton, type StatusTone } from "@/components/ui";
import {
  balanceLoading,
  balanceReady,
  balanceFailed,
  balanceText,
  showDerivedAmounts,
  formatNumber,
  formatPoints,
  formatCurrency,
  formatDate,
  isInstapayAvailable,
  groupLedgerEntries,
  type BalanceView,
  type RawLedgerEntry,
} from "@/lib/honestDisplay";

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

const PRESET_AMOUNTS = [
  { egp: 50, points: 500 },
  { egp: 100, points: 1000 },
  { egp: 250, points: 2500 },
  { egp: 500, points: 5000 },
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
  const [userBalance, setUserBalance] = useState<BalanceView>(balanceLoading());
  const [ledgerEntries, setLedgerEntries] = useState<RawLedgerEntry[]>([]);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [history, setHistory] = useState<TopupRecord[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [copiedHandle, setCopiedHandle] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

  const rawInstapayHandle = process.env.NEXT_PUBLIC_INSTAPAY_HANDLE;
  const rawInstapayPhone = process.env.NEXT_PUBLIC_INSTAPAY_PHONE;
  const instapayConfigured = isInstapayAvailable(rawInstapayHandle, rawInstapayPhone);

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
      setUserBalance(balanceReady(total));
      let running = 0;
      const computed: RawLedgerEntry[] = allDocs.map((doc) => {
        running += (doc.delta as number) || 0;
        const extractedJobId = doc.jobId || (doc.$id.match(/^(?:res|rel|chg)_(.+)$/)?.[1]);
        return {
          $id: doc.$id,
          type: doc.type,
          delta: doc.delta,
          reference: doc.reference,
          note: doc.note,
          jobId: extractedJobId,
          createdAt: doc.createdAt,
          runningBalance: running,
        };
      });
      setLedgerEntries(computed);
    } catch {
      // A failed request proves nothing about the balance — never show a fake zero.
      setUserBalance(balanceFailed());
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
  const groupedRows = useMemo(() => groupLedgerEntries(ledgerEntries).slice(0, 30), [ledgerEntries]);

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
            {dataLoading || userBalance.status === "loading" ? (
              <Skeleton className="mt-2 h-11 w-40 !bg-white/10" />
            ) : userBalance.status === "failed" ? (
              <div className="mt-1.5">
                <p className="text-2xl font-bold text-sand-200">تعذّر تحميل الرصيد</p>
                <button type="button" onClick={() => { setDataLoading(true); void loadLedgerAndBalance(); }} className="mt-1 text-sm font-bold text-amber-points underline cursor-pointer">
                  إعادة المحاولة
                </button>
              </div>
            ) : (
              <p className="tnum mt-1.5 text-4xl font-bold sm:text-5xl">
                {balanceText(userBalance)} <span className="text-lg font-bold text-amber-points">نقطة</span>
              </p>
            )}
            <p className="tnum mt-2 text-sm text-sand-300">
              {showDerivedAmounts(userBalance)
                ? `≈ ${formatCurrency((userBalance.value ?? 0) * creditRate)} · السعر المعتمد: ١ نقطة = ${formatCurrency(creditRate)}`
                : `السعر المعتمد: ١ نقطة = ${formatCurrency(creditRate)}`}
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
                      <span className="tnum block text-xs font-bold text-ink-900">{formatNumber(p.egp)} ج.م</span>
                      <span className="tnum mt-0.5 block text-xs font-bold text-amber-points">{formatPoints(p.points)}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <Field label="المبلغ بالجنيه المصري" htmlFor="amount" hint={`يعطيك هذا المبلغ: ${formatPoints(estimatedCredits)}`}>
              <Input id="amount" type="number" min={10} step={5} required dir="ltr" value={amountEgp} onChange={(e) => setAmountEgp(Number(e.target.value))} className="tnum text-left font-mono" />
            </Field>
            <Field label="رقم العملية المرجعي" htmlFor="ref" hint="يظهر في إشعار تأكيد التحويل داخل تطبيق انستاباي.">
              <Input id="ref" type="text" required dir="ltr" placeholder="مثال: 418290384729" value={reference} onChange={(e) => setReference(e.target.value)} className="text-left font-mono" />
            </Field>
            <Field label="صورة إيصال التحويل (اختياري)" htmlFor="receipt" hint="PNG أو JPG أو PDF — بحد أقصى 5 ميجابايت.">
              <div className="flex flex-wrap items-center gap-3">
                <label
                  htmlFor="receipt"
                  className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-xl border border-sand-300 bg-sand-100 px-4 py-2 text-xs font-bold text-ink-800 transition-colors hover:bg-sand-200 focus-within:ring-2 focus-within:ring-accent"
                >
                  اختر صورة الإيصال
                </label>
                <input
                  id="receipt"
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,application/pdf"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  className="sr-only"
                />
                <span className="text-xs text-sand-600 truncate max-w-xs">
                  {file ? file.name : "لم يتم اختيار ملف"}
                </span>
                {file && (
                  <button
                    type="button"
                    onClick={() => setFile(null)}
                    className="text-xs text-danger hover:underline cursor-pointer"
                  >
                    إلغاء
                  </button>
                )}
              </div>
            </Field>
            <Button type="submit" size="lg" variant="accent" className="w-full" disabled={loading}>
              {loading ? "جاري إرسال الطلب..." : "تأكيد وإرسال طلب الشحن"}
            </Button>
          </form>
        </Card>

        <Card className="space-y-5 bg-sand-50/50 p-6 lg:col-span-5">
          <div>
            <h3 className="text-sm font-bold text-ink-900">بيانات التحويل عبر Instapay</h3>
            <p className="mt-1 text-xs text-sand-600">
              {instapayConfigured ? "انسخ البيانات التالية لاستخدامها في تطبيق انستاباي." : "خدمة الشحن المباشر عبر انستاباي."}
            </p>
          </div>
          {instapayConfigured ? (
            <>
              {[
                { label: "عنوان الدفع اللحظي (IPA)", value: rawInstapayHandle!, copied: copiedHandle, type: "handle" as const },
                { label: "أو عبر رقم الهاتف", value: rawInstapayPhone!, copied: copiedPhone, type: "phone" as const },
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
            </>
          ) : (
            <Alert tone="warning" title="الشحن غير متاح حاليًا">
              الشحن غير متاح حاليًا — يرجى التواصل مع فريق الدعم أو المحاولة في وقت لاحق.
            </Alert>
          )}
        </Card>
      </div>

      {/* Ledger */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-sand-100 p-5">
          <h2 className="text-base font-bold text-ink-900">سجل حركات المحفظة</h2>
          <span className="tnum text-xs text-sand-500">آخر {formatNumber(30)} حركة</span>
        </div>
        {dataLoading ? (
          <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : groupedRows.length === 0 ? (
          <EmptyState title="لا توجد حركات بعد" description="ستظهر هنا كل عمليات الشحن والحجز والخصم والاسترداد." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-sand-100 bg-sand-50/60 text-sand-600">
                  <th scope="col" className="px-4 py-3 font-semibold">التاريخ</th>
                  <th scope="col" className="px-4 py-3 font-semibold">نوع الحركة</th>
                  <th scope="col" className="px-4 py-3 font-semibold">التغيّر الصافي</th>
                  <th scope="col" className="px-4 py-3 font-semibold">الرصيد بعدها</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-100">
                {groupedRows.map((row) => {
                  const positive = row.netDelta > 0;
                  const isExpanded = Boolean(expandedRows[row.key]);
                  return (
                    <tbody key={row.key} className="divide-y divide-sand-100 border-b border-sand-100 last:border-b-0">
                      <tr className="transition-colors hover:bg-sand-50/60">
                        <td className="tnum whitespace-nowrap px-4 py-3 text-sand-500">
                          {formatDate(row.createdAt, { dateStyle: "short", timeStyle: "short" })}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            {row.isJob ? (
                              <>
                                <Badge tone={row.netDelta < 0 ? "danger" : row.netDelta > 0 ? "success" : "neutral"}>
                                  {row.netDelta < 0 ? "خصم الطلب" : row.netDelta === 0 ? "تسوية كاملة" : "إيداع"}
                                </Badge>
                                <span className="font-semibold text-ink-900">{row.title}</span>
                                <button
                                  type="button"
                                  onClick={() => setExpandedRows((prev) => ({ ...prev, [row.key]: !prev[row.key] }))}
                                  className="inline-flex items-center gap-1 text-xs font-bold text-accent hover:underline cursor-pointer"
                                  aria-expanded={isExpanded}
                                >
                                  <span>التفاصيل</span>
                                  <svg className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                                  </svg>
                                </button>
                              </>
                            ) : (
                              <>
                                <Badge tone={LEDGER_TYPE[row.movements[0]?.type || "topup"]?.tone ?? "neutral"}>
                                  {LEDGER_TYPE[row.movements[0]?.type || "topup"]?.label ?? row.movements[0]?.type ?? "حركة رصيد"}
                                </Badge>
                                <span className="text-ink-800">{row.title}</span>
                              </>
                            )}
                          </div>
                        </td>
                        <td className={`tnum whitespace-nowrap px-4 py-3 font-bold ${positive ? "text-success" : row.netDelta < 0 ? "text-danger" : "text-sand-600"}`} dir="ltr">
                          {positive ? `+${formatNumber(row.netDelta)}` : row.netDelta < 0 ? `-${formatNumber(Math.abs(row.netDelta))}` : "٠"}
                        </td>
                        <td className="tnum whitespace-nowrap px-4 py-3 font-semibold text-ink-900">
                          {formatPoints(row.runningBalance)}
                        </td>
                      </tr>
                      {row.isJob && isExpanded && (
                        <tr className="bg-sand-50/70">
                          <td colSpan={4} className="px-4 py-3">
                            <div className="space-y-2 rounded-xl border border-sand-200 bg-white p-3.5">
                              <p className="text-xs font-bold text-ink-900">تفاصيل حركات هذا الطلب:</p>
                              <ul className="divide-y divide-sand-100 text-xs">
                                {row.movements.map((m) => {
                                  const mType = m.type || "adjust";
                                  const meta = LEDGER_TYPE[mType] ?? { label: m.type || "حركة", tone: "neutral" as StatusTone };
                                  const mPos = m.delta > 0;
                                  return (
                                    <li key={m.$id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                                      <div className="flex items-center gap-2">
                                        <Badge tone={meta.tone}>{meta.label}</Badge>
                                        <span className="tnum text-sand-500">{formatDate(m.createdAt, { dateStyle: "short", timeStyle: "short" })}</span>
                                        {m.note && <span className="text-sand-700">({m.note})</span>}
                                      </div>
                                      <div className="flex items-center gap-3">
                                        <span className={`tnum font-bold ${mPos ? "text-success" : "text-danger"}`} dir="ltr">
                                          {mPos ? `+${formatNumber(m.delta)}` : `-${formatNumber(Math.abs(m.delta))}`}
                                        </span>
                                        {m.runningBalance !== undefined && (
                                          <span className="tnum text-sand-500">الرصيد: {formatPoints(m.runningBalance)}</span>
                                        )}
                                      </div>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
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
                      {formatNumber(item.amountEgp)} ج.م
                      {item.credits ? <span className="text-amber-points"> · +{formatPoints(item.credits)}</span> : null}
                    </p>
                    <p className="tnum mt-0.5 text-xs text-sand-500" dir="ltr">
                      {item.reference} · {formatDate(item.createdAt)}
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
