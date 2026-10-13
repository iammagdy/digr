"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Functions } from "appwrite";
import { account, client } from "@/lib/appwrite";
import { adminFetch, downloadCsv } from "@/lib/adminApi";
import { formatAr, normalizeDigits } from "@/lib/arabicDigits";
import { useCreditValue } from "@/hooks/useCreditValue";
import { useAdmin } from "@/components/admin/AdminShell";
import { KV, Sheet, SheetHandle } from "@/components/admin/Sheet";
import { EGP, badgeFor, dateTimeAr, initials, tint } from "@/components/admin/format";

const functions = new Functions(client);

interface AdminTopup {
  id: string; userId: string; accName: string; accEmail: string; senderName: string; senderPhone: string; amountEgp: number;
  confirmedAmountEgp: number | null; credits: number | null; reference: string; receiptFileId: string | null; status: "pending" | "approved" | "rejected";
  rejectReason: string | null; createdAt: string; reviewedAt: string | null; previous: number; previousApproved: number;
}
interface TopupStats { pendingCount: number; pendingValueEgp: number; approvedThisMonthEgp: number; avgReviewMinutes: number | null }
interface UserInfo { balance: number }

const REJ_REASONS = ["الرقم المرجعي غير مطابق للإيصال", "المبلغ المحوّل مختلف", "الإيصال غير واضح", "لم يصل التحويل بعد", "اسم المحوِّل غير مطابق"];
const TABS: Array<["pending" | "approved" | "rejected" | "all", string]> = [["pending", "المعلقة"], ["approved", "المعتمدة"], ["rejected", "المرفوضة"], ["all", "الكل"]];
const CARD = "rounded-[18px] border border-ln bg-sf p-3.5";

function useReceiptUrl(fileId: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl(null); setFailed(false);
    if (!fileId) return;
    let alive = true, obj = "";
    (async () => {
      try {
        const jwt = (await account.createJWT()).jwt;
        const res = await fetch(`/api/admin/receipts/${fileId}`, { headers: { Authorization: `Bearer ${jwt}` } });
        if (!res.ok) throw new Error(String(res.status));
        obj = URL.createObjectURL(await res.blob());
        if (alive) setUrl(obj);
      } catch { if (alive) setFailed(true); }
    })();
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [fileId]);
  return { url, failed };
}

export default function AdminTopupsPage() {
  const { refresh, toast, pendingOpenTopup, setPendingOpenTopup, isMobile } = useAdmin();
  const creditValue = useCreditValue();
  const [topups, setTopups] = useState<AdminTopup[]>([]);
  const [stats, setStats] = useState<TopupStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await adminFetch<{ topups: AdminTopup[]; stats: TopupStats }>("/api/admin/topups");
      setTopups(res.topups); setStats(res.stats);
    } catch (e) {
      setBanner({ ok: false, text: e instanceof Error ? e.message : "تعذّر تحميل الطلبات" });
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Deep link from the admin bell / a user sheet.
  useEffect(() => {
    if (pendingOpenTopup && topups.some((t) => t.id === pendingOpenTopup)) { setFilter("pending"); setOpen(pendingOpenTopup); setPendingOpenTopup(null); }
  }, [pendingOpenTopup, topups, setPendingOpenTopup]);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("status") && ["pending", "approved", "rejected", "all"].includes(q.get("status")!)) setFilter(q.get("status") as typeof filter);
  }, []);

  const list = useMemo(() => topups.filter((t) => filter === "all" || t.status === filter), [topups, filter]);
  const count = (s: string) => (s === "all" ? topups.length : topups.filter((t) => t.status === s).length);
  const selected = open ? topups.find((t) => t.id === open) ?? null : null;

  const exportRows = () => {
    const rows = topups.filter((t) => (sel.length ? sel.includes(t.id) : list.some((l) => l.id === t.id)));
    downloadCsv("diger-topups.csv", [
      ["المعرّف", "اسم المحوِّل", "الموبايل", "الرقم المرجعي", "البريد", "المبلغ (ج.م)", "الحالة", "سبب الرفض", "تاريخ الطلب"],
      ...rows.map((t) => [t.id, t.senderName, t.senderPhone, t.reference, t.accEmail, t.amountEgp, badgeFor(t.status).label, t.rejectReason ?? "", t.createdAt]),
    ]);
    toast(`تم تصدير ${formatAr(rows.length)} طلب إلى CSV`);
  };

  const onReviewed = (id: string, patch: Partial<AdminTopup>, message: string, ok: boolean) => {
    setTopups((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    setOpen(null);
    setBanner({ ok, text: message });
    refresh();
    void load();
  };

  const statCards = [
    { k: "بانتظار المراجعة", v: formatAr(stats?.pendingCount ?? 0), c: "var(--goldT)" },
    { k: "قيمة المعلّق", v: EGP(stats?.pendingValueEgp ?? 0), c: "var(--ink)" },
    { k: "معتمد هذا الشهر", v: EGP(stats?.approvedThisMonthEgp ?? 0), c: "var(--ok)" },
    { k: "متوسط وقت المراجعة", v: stats?.avgReviewMinutes == null ? "—" : `${formatAr(stats.avgReviewMinutes)} دقيقة`, c: "var(--ink)" },
  ];

  return (
    <div data-screen-label="Topups" className="flex flex-col gap-3.5">
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,160px),1fr))" }}>
        {statCards.map((s) => (
          <div key={s.k} className="rounded-[18px] border border-ln bg-sf p-3.5"><p className="m-0 text-xs text-mut">{s.k}</p><p className="mb-0 mt-1.5 font-display text-[30px] leading-none" style={{ color: s.c }}>{s.v}</p></div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-[14px] bg-sf2 p-1" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => { setFilter(id); setSel([]); }}
              className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-[10px] border-0 px-3 text-xs font-semibold"
              style={{ background: filter === id ? "var(--sf)" : "transparent", color: filter === id ? "var(--ink)" : "var(--mut)", boxShadow: filter === id ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}>
              {label} <span className="opacity-60">{formatAr(count(id))}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setSel(sel.length && sel.length === list.length ? [] : list.map((t) => t.id))} className="min-h-11 cursor-pointer whitespace-nowrap rounded-xl border border-ln2 bg-sf px-3 text-xs text-ink">{sel.length && sel.length === list.length ? "إلغاء تحديد الكل" : "تحديد الكل"}</button>
          <button type="button" onClick={exportRows} className="min-h-11 cursor-pointer whitespace-nowrap rounded-xl border border-ln2 bg-sf px-3 text-xs text-ink">تصدير CSV</button>
        </div>
      </div>

      {banner && <div role="status" className="rounded-[14px] px-4 py-3 text-[13px]" style={{ background: tint(banner.ok ? "var(--ok)" : "var(--bad)", 12), color: banner.ok ? "var(--ok)" : "var(--bad)", animation: "up .3s both" }}>{banner.text}</div>}

      {sel.length > 0 && (
        <div className="sticky top-[72px] z-[5] flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-ink px-3.5 py-2.5 text-[13px] text-bg" style={{ animation: "up .25s both" }}>
          <span>تم تحديد {formatAr(sel.length)} طلب</span>
          <span className="flex gap-1.5">
            <button type="button" onClick={exportRows} className="min-h-11 cursor-pointer rounded-full border-0 bg-bg px-3.5 text-xs font-semibold text-ink">تصدير المحدد</button>
            <button type="button" onClick={() => setSel([])} className="min-h-11 cursor-pointer rounded-full border bg-transparent px-3 text-xs text-bg" style={{ borderColor: "rgba(255,255,255,.3)" }}>إلغاء</button>
          </span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {loading && [0, 1, 2].map((i) => <div key={i} className="h-[76px] rounded-[18px] bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />)}
        {!loading && list.map((t) => {
          const b = badgeFor(t.status);
          const pending = t.status === "pending";
          const checked = sel.includes(t.id);
          return (
            <div key={t.id} className="flex items-center gap-1">
              <button type="button" role="checkbox" aria-checked={checked} aria-label="تحديد الطلب" onClick={() => setSel(checked ? sel.filter((x) => x !== t.id) : [...sel, t.id])} className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent">
                <span className="flex h-5 w-5 items-center justify-center rounded-md text-xs leading-none text-white" style={{ border: `1.5px solid ${checked ? "var(--gold)" : "var(--ln2)"}`, background: checked ? "var(--gold)" : "transparent" }}>{checked ? "✓" : ""}</span>
              </button>
              <button
                type="button" onClick={() => setOpen(t.id)}
                className="grid min-w-0 flex-1 cursor-pointer items-center gap-3.5 rounded-[18px] border bg-sf px-4 py-3.5 text-right text-ink transition-[border-color,box-shadow] hover:border-ln2 hover:shadow-[var(--admin-shadow)] grid-cols-[42px_minmax(0,1fr)_auto] min-[900px]:grid-cols-[42px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]"
                style={{ borderColor: pending ? tint("var(--gold)", 45) : "var(--ln)" }}
              >
                <span className="flex h-[42px] w-[42px] items-center justify-center rounded-full text-[13px] font-semibold" style={{ background: pending ? tint("var(--gold)", 16) : "var(--sf2)", color: pending ? "var(--goldT)" : "var(--mut)" }}>{initials(t.senderName)}</span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink">{t.senderName || "—"}</span>
                  <span className="block truncate text-[11px] text-fnt"><span dir="ltr">{t.senderPhone}</span>{!isMobile && <> · {dateTimeAr(t.createdAt)}</>}</span>
                </span>
                <span className="hidden min-w-0 min-[900px]:block"><span className="block text-[11px] text-fnt">الرقم المرجعي</span><span dir="ltr" className="block text-right text-xs text-ink2" style={{ fontFamily: "ui-monospace,monospace" }}>{t.reference}</span></span>
                <span className="hidden min-w-0 min-[900px]:block"><span className="block text-[11px] text-fnt">الحساب</span><span dir="ltr" className="block truncate text-right text-xs text-ink2">{t.accEmail}</span></span>
                <span className="flex flex-col items-end gap-[5px]">
                  <span className="whitespace-nowrap font-display text-2xl leading-none text-ink">{EGP(t.amountEgp)}</span>
                  <span className="whitespace-nowrap rounded-full px-[9px] py-0.5 text-[11px] font-semibold" style={{ background: b.bg, color: b.fg }}>{b.label}</span>
                </span>
              </button>
            </div>
          );
        })}
        {!loading && list.length === 0 && <p className="m-0 p-10 text-center text-[13px] text-fnt">لا توجد طلبات في هذا القسم حاليًا.</p>}
      </div>

      {selected && <TopupSheet t={selected} creditValue={creditValue} onClose={() => setOpen(null)} onReviewed={onReviewed} toast={toast} />}
    </div>
  );
}

function TopupSheet({ t, creditValue, onClose, onReviewed, toast }: {
  t: AdminTopup; creditValue: number; onClose: () => void; toast: (m: string) => void;
  onReviewed: (id: string, patch: Partial<AdminTopup>, message: string, ok: boolean) => void;
}) {
  const b = badgeFor(t.status);
  const pending = t.status === "pending";
  const [confirm, setConfirm] = useState(String(t.amountEgp));
  const [armed, setArmed] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const { url: receiptUrl, failed: receiptFailed } = useReceiptUrl(t.receiptFileId);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { adminFetch<UserInfo>(`/api/admin/users/${t.userId}`).then(setUser).catch(() => {}); }, [t.userId]);

  const num = Number(normalizeDigits(confirm).replace(",", "."));
  const pts = num > 0 ? Math.floor(num / creditValue) : 0;
  const mismatch = !!(t.accName && t.senderName && t.senderName.split(" ")[0] !== t.accName.split(" ")[0]);
  const ptsLine = t.status === "approved" ? `أُضيف ${formatAr(t.credits ?? 0)} نقطة` : `≈ ${formatAr(Math.floor(t.amountEgp / creditValue))} نقطة عند الاعتماد`;
  const long = t.status === "approved" ? `معتمد (+${formatAr(t.credits ?? 0)} نقطة)` : pending ? "معلق قيد المراجعة" : "مرفوض";

  const copy = (key: string, val: string) => async () => {
    try { await navigator.clipboard?.writeText(val); } catch { /* blocked */ }
    setCopied(key); setTimeout(() => setCopied(null), 1500);
  };

  const call = async (body: Record<string, unknown>) => {
    const exec = await functions.createExecution("approve-topup", JSON.stringify({ topupId: t.id, ...body }), false);
    const res = JSON.parse(exec.responseBody || "{}");
    if (!res.success) throw new Error(res.error || "تعذّر تنفيذ الإجراء");
    return res;
  };

  const approve = async () => {
    if (busy) return;
    if (!(num > 0)) return toast("مدخلات غير صالحة");
    setBusy(true);
    try {
      const res = await call({ action: "approve", confirmedAmountEgp: num });
      onReviewed(t.id, { status: "approved", credits: res.credits, confirmedAmountEgp: num, reviewedAt: new Date().toISOString() }, `تم اعتماد الطلب وإضافة ${formatAr(res.credits)} نقطة للمستخدم بنجاح ✓`, true);
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر الاعتماد"); setBusy(false); }
  };

  const reject = async () => {
    if (busy) return;
    if (!armed) {
      setArmed(true); setReason(""); setNote("");
      if (armTimer.current) clearTimeout(armTimer.current);
      return;
    }
    if (!reason) return toast("اختر سبب الرفض أولًا");
    const full = reason + (note.trim() ? ` — ${note.trim()}` : "");
    setBusy(true);
    try {
      await call({ action: "reject", rejectReason: full });
      onReviewed(t.id, { status: "rejected", rejectReason: full, reviewedAt: new Date().toISOString() }, "تم رفض الطلب وإبلاغ المستخدم بالسبب", false);
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر الرفض"); setBusy(false); }
  };

  return (
    <Sheet label="تفاصيل طلب الشحن" onClose={onClose}>
      <div className="shrink-0 border-b border-ln px-[18px] pb-4 pt-3.5">
        <SheetHandle />
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className="inline-block rounded-full px-2.5 py-[3px] text-[11px] font-semibold" style={{ background: b.bg, color: b.fg }}>{long}</span>
            <p className="mb-0 mt-2.5 font-display text-[42px] leading-none text-ink">{EGP(t.amountEgp)}</p>
            <p className="mb-0 mt-1.5 text-xs text-mut">{ptsLine}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="إغلاق" className="h-11 w-11 shrink-0 cursor-pointer rounded-full border-0 bg-sf2 text-xl text-ink">×</button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-[18px]">
        <section>
          <h3 className="mb-1.5 mt-0 text-[13px] font-semibold text-mut">بيانات التحويل · Instapay</h3>
          <KV k="اسم المحوِّل الثلاثي" v={t.senderName || "—"} />
          <KV k="رقم الموبايل" v={t.senderPhone || "—"} dir="ltr" mono copy={{ label: copied === "phone" ? "تم النسخ" : "نسخ", onCopy: copy("phone", t.senderPhone) }} />
          <KV k="الرقم المرجعي" v={t.reference} dir="ltr" mono copy={{ label: copied === "ref" ? "تم النسخ" : "نسخ", onCopy: copy("ref", t.reference) }} />
          <KV k="المبلغ المحوّل" v={EGP(t.amountEgp)} />
          <KV k="تاريخ الطلب" v={dateTimeAr(t.createdAt)} />
          {mismatch && <p className="mb-0 mt-2.5 rounded-xl px-3 py-2.5 text-xs leading-[1.8] text-goldT" style={{ background: tint("var(--gold)", 12) }}>اسم المحوِّل مختلف عن اسم صاحب الحساب — طابقه مع الإيصال قبل الاعتماد.</p>}
        </section>

        <section>
          <h3 className="mb-2.5 mt-0 text-[13px] font-semibold text-mut">إيصال التحويل</h3>
          <div className="flex gap-3.5 rounded-[18px] border border-ln bg-sf p-3">
            <div dir="ltr" className="flex aspect-[9/16] w-[88px] shrink-0 items-center justify-center overflow-hidden rounded-xl border border-ln bg-sf2">
              {receiptUrl ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={receiptUrl} alt="إيصال التحويل" className="h-full w-full object-cover" /> : <span className="px-2 text-center text-[10px] text-fnt">{receiptFailed ? "تعذّر تحميل المعاينة" : t.receiptFileId ? "…" : "بدون إيصال"}</span>}
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
              <div>
                <p dir="ltr" className="m-0 truncate text-right text-[13px] font-medium text-ink">receipt-{t.reference}</p>
                <p className="mb-0 mt-1 text-xs text-fnt">{t.receiptFileId ? "مرفوع مع الطلب" : "لم يُرفق إيصال (طلب قديم)"}</p>
              </div>
              {receiptUrl && <a href={receiptUrl} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center self-start rounded-full border border-ln2 px-3.5 text-xs text-ink">فتح بالحجم الكامل ↗</a>}
            </div>
          </div>
        </section>

        <section>
          <h3 className="mb-1.5 mt-0 text-[13px] font-semibold text-mut">حساب العميل</h3>
          <KV k="اسم الحساب" v={t.accName || "—"} />
          <KV k="البريد" v={t.accEmail || "—"} dir="ltr" />
          <KV k="الرصيد الحالي" v={user ? `${formatAr(user.balance)} نقطة` : "…"} />
          <KV k="طلبات سابقة" v={formatAr(t.previous)} />
        </section>

        {pending ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-mut">المبلغ المؤكد بعد مراجعة الحوالة</span>
            <span className="flex min-h-[54px] items-center gap-2 rounded-2xl border border-ln2 bg-sf px-4">
              <input type="text" inputMode="decimal" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="min-w-0 flex-1 border-0 bg-transparent text-lg font-semibold text-ink outline-none" />
              <span className="whitespace-nowrap text-xs text-fnt">ج.م = {formatAr(pts)} نقطة</span>
            </span>
          </label>
        ) : (
          <p className="m-0 text-xs text-fnt">
            {t.status === "rejected" && t.rejectReason ? `سبب الرفض: ${t.rejectReason} · ` : ""}{t.reviewedAt ? `تمت المعالجة · ${dateTimeAr(t.reviewedAt)}` : "تمت المعالجة"}
          </p>
        )}
      </div>

      {pending && armed && (
        <div className="flex shrink-0 flex-col gap-2.5 border-t border-ln bg-bg px-[18px] pb-1.5 pt-3.5" style={{ animation: "up .25s both" }}>
          <p className="m-0 text-[13px] font-semibold text-bad">سبب الرفض — سيظهر للمستخدم ويُرسل على بريده</p>
          <div className="flex flex-wrap gap-1.5">
            {REJ_REASONS.map((r) => (
              <button key={r} type="button" onClick={() => setReason(r)} aria-pressed={reason === r} className="min-h-11 cursor-pointer rounded-full px-3 text-xs" style={{ border: `1px solid ${reason === r ? "var(--bad)" : "var(--ln2)"}`, background: reason === r ? tint("var(--bad)", 12) : "var(--sf)", color: reason === r ? "var(--bad)" : "var(--ink)" }}>{r}</button>
            ))}
          </div>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="تفاصيل إضافية (اختياري)" maxLength={120} className="min-h-[46px] rounded-xl border border-ln bg-sf px-3.5 text-base text-ink outline-none" />
          <button type="button" onClick={() => { setArmed(false); setReason(""); }} className="min-h-11 cursor-pointer self-start border-0 bg-transparent p-0 text-xs text-mut">إلغاء الرفض</button>
        </div>
      )}

      {/* Approve / reject stay pinned while the data above scrolls. */}
      {pending && (
        <div className="grid shrink-0 grid-cols-2 gap-2 border-t border-ln px-[18px] pt-3" style={{ paddingBottom: "calc(16px + env(safe-area-inset-bottom))", boxShadow: "0 -12px 24px -16px rgba(0,0,0,.25)" }}>
          <button type="button" onClick={reject} disabled={busy} className="min-h-[54px] cursor-pointer whitespace-nowrap rounded-full text-sm font-semibold" style={{ border: "1px solid var(--bad)", background: armed ? (reason ? "var(--bad)" : tint("var(--bad)", 35)) : "transparent", color: armed ? "#fff" : "var(--bad)", opacity: busy ? 0.55 : 1 }}>
            {busy ? "..." : armed ? "تأكيد الرفض" : "رفض ✕"}
          </button>
          <button type="button" onClick={approve} disabled={busy} className="min-h-[54px] cursor-pointer whitespace-nowrap rounded-full border-0 text-sm font-semibold text-white" style={{ background: "var(--ok-btn, #1f5e3b)", opacity: busy ? 0.55 : 1 }}>
            {busy ? "..." : "اعتماد ✓"}
          </button>
        </div>
      )}
    </Sheet>
  );
}
