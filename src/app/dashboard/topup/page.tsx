"use client";

import { pointsAr } from "@/lib/pointsFormat";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/hooks/useUser";
import { useBalance } from "@/hooks/useBalance";
import { useCreditValue } from "@/hooks/useCreditValue";
import { Icon, UI } from "@/components/app/icons";
import { balanceText, formatDate, formatTime, isIpaAvailable } from "@/lib/honestDisplay";
import { formatAr } from "@/lib/arabicDigits";
import { CREDIT_LEDGER_COLLECTION, JOBS_COLLECTION, SETTINGS_PUBLIC_COLLECTION, TOPUPS_COLLECTION } from "@/lib/constants";
import { ILLUSTRATIVE_SEARCH_PRICES } from "@/lib/pricing";
import { startNotificationPolling } from "@/lib/notificationPolling";
import { getSlowFactor } from "@/lib/degradedClient";
import SubmittedCard from "./SubmittedCard";
import TopupForm from "./TopupForm";
import PromoCodeBox from "./PromoCodeBox";
import { CREDIT_KIND_LABEL_AR, classifyLedgerRow } from "@/lib/creditKinds";
import { TOPUP_REQUEST_LABEL_AR, walletDisplayText, walletNoteForDisplay } from "@/lib/walletText";
import { creditedPointsByTopup, creditedPointsOf, kindOfLedgerRow as kindOf, visibleLedgerRows, walletMonthStats, type WalletLedgerKind as LedgerKind } from "@/lib/walletView";
import { statusBadge, USER_STATUS, type LedgerRow, type TopupRecord } from "./types";

const ledgerLabel = (row: LedgerRow): string => walletDisplayText(row.labelAr || CREDIT_KIND_LABEL_AR[classifyLedgerRow({ type: row.type, kind: row.kind })]);
const LEDGER_TABS: Array<["all" | LedgerKind, string]> = [["all", "الكل"], ["topup", "شحن"], ["charge", "خصم وحجز"], ["refund", "حجز مُحرَّر"]];

const ipaFromEnv = process.env.NEXT_PUBLIC_INSTAPAY_HANDLE;

/** عدد الأبحاث بالمعدود الصحيح: بحث واحد · بحثين · ٣ أبحاث · ١١ بحثًا */
function searchesAr(n: number): string {
  if (n === 1) return "بحث واحد";
  if (n === 2) return "بحثين";
  return `${formatAr(n)} ${n >= 3 && n <= 10 ? "أبحاث" : "بحثًا"}`;
}

function safeReturn(raw: string | null): string {
  return raw && /^\/dashboard\/[A-Za-z0-9/_?=&%-]*$/.test(raw) ? raw : "/dashboard/chat";
}

export default function WalletPage() {
  const { user } = useUser();
  const router = useRouter();
  const { balance, refresh: refreshBalance } = useBalance();
  const creditValue = useCreditValue();

  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [ledgerFailed, setLedgerFailed] = useState(false);
  const [ledgerLoaded, setLedgerLoaded] = useState(false);
  const [topups, setTopups] = useState<TopupRecord[]>([]);
  const [monthRows, setMonthRows] = useState(0);
  const [ledFilter, setLedFilter] = useState<"all" | LedgerKind>("all");
  const [amount, setAmount] = useState(100);
  const [submitted, setSubmitted] = useState<TopupRecord | null>(null);
  const [ipa, setIpa] = useState<string | null>(isIpaAvailable(ipaFromEnv) ? ipaFromEnv! : null);
  const [loadingIpa, setLoadingIpa] = useState(!isIpaAvailable(ipaFromEnv));
  const [ipaLoadFailed, setIpaLoadFailed] = useState(false);
  const [maxPending, setMaxPending] = useState(3);
  const formRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef("/dashboard/chat");

  /* ?amount=…&return=… from the chat's «اشحن {الفرق} والعودة هنا» */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const a = Number(q.get("amount"));
    if (Number.isFinite(a) && a > 0) setAmount(a);
    returnTo.current = safeReturn(q.get("return"));
  }, []);

  /* public settings: IPA + pending cap (fall back to env / 3) */
  useEffect(() => {
    let active = true;
    const timeout = setTimeout(() => {
      if (active) {
        setLoadingIpa(false);
        setIpaLoadFailed(true);
      }
    }, 8000);
    try {
      const supabase = createClient();
      Promise.resolve(
        supabase.from(SETTINGS_PUBLIC_COLLECTION).select("value").eq("key", "pricing").maybeSingle()
      )
        .then(({ data }) => {
          if (!active) return;
          setIpaLoadFailed(false);
          const d = (data?.value || {}) as { ipa?: string; maxPendingTopups?: number };
          if (isIpaAvailable(d.ipa)) setIpa(d.ipa!.trim());
          if (Number.isInteger(d.maxPendingTopups) && d.maxPendingTopups! > 0) setMaxPending(d.maxPendingTopups!);
        })
        .catch(() => { if (active) setIpaLoadFailed(true); })
        .finally(() => {
          if (active) setLoadingIpa(false);
          clearTimeout(timeout);
        });
    } catch {
      setLoadingIpa(false);
      setIpaLoadFailed(true);
    }
    return () => { active = false; clearTimeout(timeout); };
  }, []);

  const loadLedger = useCallback(async () => {
    if (!user) return;
    try {
      // Typed history from the server (real top-ups, promo credit, admin gifts); the direct read below is the fallback.
      const res = await fetch("/api/wallet/history", { cache: "no-store" });
      const typed = res.ok ? await res.json().catch(() => null) : null;
      if (typed?.success && Array.isArray(typed.rows)) {
        setLedger(typed.rows.map((r: any) => ({
          $id: r.id, id: r.id, delta: Number(r.delta), type: r.type, kind: r.kind, labelAr: r.labelAr,
          jobId: r.jobId, topupId: r.topupId, note: r.note || "", createdAt: r.createdAt,
        })));
        setLedgerFailed(false);
        setLedgerLoaded(true);
        return;
      }
    } catch { /* fall through to the direct read */ }
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from(CREDIT_LEDGER_COLLECTION)
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      const rows: LedgerRow[] = (data || []).map((r: any) => ({
        $id: r.id,
        id: r.id,
        userId: r.user_id,
        delta: Number(r.delta),
        type: r.type,
        jobId: r.job_id,
        topupId: r.topup_id,
        note: r.note || "",
        createdAt: r.created_at,
      }));
      setLedger(rows);
      setLedgerFailed(false);
      setLedgerLoaded(true);
    } catch {
      setLedgerFailed(true);
    }
  }, [user]);

  const loadTopups = useCallback(async () => {
    if (!user) return;
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from(TOPUPS_COLLECTION)
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);
      setTopups(
        (data || []).map((r: any) => ({
          $id: r.id,
          id: r.id,
          userId: r.user_id,
          amountEgp: Number(r.amount_egp),
          reference: r.reference,
          senderName: r.sender_name || "",
          senderPhone: r.sender_phone || "",
          receiptFileId: r.receipt_file_id || null,
          status: r.status,
          rejectReason: r.reject_reason || null,
          credits: r.credits ? Number(r.credits) : null,
          createdAt: r.created_at,
          reviewedAt: r.reviewed_at || null,
        }))
      );
    } catch { /* none yet */ }
  }, [user]);

  useEffect(() => { void loadLedger(); void loadTopups(); }, [loadLedger, loadTopups]);

  /* records delivered this month (for «خُصم هذا الشهر … على N سجلًا») */
  useEffect(() => {
    if (!user) return;
    const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
    try {
      const supabase = createClient();
      Promise.resolve(
        supabase
          .from(JOBS_COLLECTION)
          .select("delivered_units")
          .eq("user_id", user.id)
          .in("status", ["completed", "done"])
          .gte("created_at", start.toISOString())
          .limit(100)
      )
        .then(({ data }) => setMonthRows((data || []).reduce((a, d: any) => a + (Number(d.delivered_units) || 0), 0)))
        .catch(() => {});
    } catch {}
  }, [user, ledger.length]);

  /* status of topup requests (approve / reject by the admin): polled while one is waiting, never a live connection */
  const hasPendingTopup = topups.some((t) => t.status === "pending");
  const statusesRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    statusesRef.current = new Map(topups.map((t) => [t.$id, t.status]));
    setSubmitted((cur) => (cur ? topups.find((t) => t.$id === cur.$id) ?? cur : cur));
  }, [topups]);
  useEffect(() => {
    if (!user || !hasPendingTopup || typeof document === "undefined") return;
    // One small question (the status of the requests still waiting); only a change reads the full list again.
    const check = async (): Promise<boolean> => {
      const pendingIds = [...statusesRef.current].filter(([, status]) => status === "pending").map(([id]) => id);
      if (pendingIds.length === 0) return false;
      const supabase = createClient();
      const { data } = await supabase.from(TOPUPS_COLLECTION).select("id, status").eq("user_id", user.id).in("id", pendingIds);
      const changed = (data || []).filter((r: any) => r.status !== "pending");
      if (changed.length === 0) return false;
      await loadTopups();
      if (changed.some((r: any) => r.status === "approved")) { void refreshBalance(); void loadLedger(); }
      return true;
    };
    return startNotificationPolling({
      load: async () => { await check(); },
      tick: check,
      intervalMs: 20_000,
      jitter: 0.2,
      slowFactor: getSlowFactor,
      backoff: { factor: 1.5, maxIntervalMs: 90_000 },
      isVisible: () => document.visibilityState !== "hidden",
      visibilityTarget: document,
      focusTarget: window,
    });
  }, [user, hasPendingTopup, loadTopups, refreshBalance, loadLedger]);

  /* month figures + held points from the ledger */
  const stats = useMemo(() => walletMonthStats(ledger), [ledger]);

  const available = balance.status === "ready" ? balance.value! : null;
  const total = (available ?? 0) + stats.held;
  const pendingCount = topups.filter((t) => t.status === "pending").length;
  /* points an approved top-up credited, read from its ledger row (approve_topup_atomic writes it as top_<id> with no topup_id) */
  const creditsByTopup = creditedPointsByTopup(ledger);
  const displayTopups = topups.map((topup) => ({ ...topup, credits: creditedPointsOf(topup, creditsByTopup) }));
  const displaySubmitted = submitted ? { ...submitted, credits: creditedPointsOf(submitted, creditsByTopup) } : null;

  const visibleLedger = visibleLedgerRows(ledger, ledFilter);

  const scrollToForm = () => {
    setSubmitted(null);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  return (
    <div data-screen-label="Wallet" className="flex-1">
      <div className="mx-auto max-w-[720px] px-5 pb-16 pt-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="m-0 font-display text-4xl font-medium leading-[1.1] text-ink">المحفظة</h2>
            <p className="mb-0 mt-1 text-[13px] font-light text-mut">النقطة الواحدة = {formatAr(creditValue, 2)} ج.م · تدفع على السجلات المسلَّمة فقط</p>
          </div>
          <button type="button" onClick={scrollToForm} className="min-h-11 cursor-pointer whitespace-nowrap rounded-full border-0 bg-ac px-4 text-[13px] text-onac">+ شحن الرصيد</button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5 min-[760px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="col-span-2 flex flex-col gap-3 rounded-[20px] border border-ln bg-sf p-4 min-[760px]:col-span-1">
            <div className="flex items-end justify-between gap-2.5">
              <div>
                <p className="m-0 text-xs text-mut">متاح للاستخدام</p>
                <p className="mb-0 mt-1.5 text-[34px] font-medium leading-none tracking-[-.01em] text-ink">
                  {balance.status === "failed" ? "غير متاح" : balanceText(balance)} <span className="text-[13px] font-normal text-mut">نقطة</span>
                </p>
              </div>
              {available !== null && <p className="m-0 text-[13px] text-mut">≈ {formatAr(Number((available * creditValue).toFixed(2)))} ج.م</p>}
            </div>
            <div className="flex h-1.5 overflow-hidden rounded-md bg-sf2">
              <span style={{ width: `${total > 0 ? ((available ?? 0) / total) * 100 : 0}%`, background: "var(--ac)" }} />
              <span style={{ width: `${total > 0 ? (stats.held / total) * 100 : 0}%`, background: "var(--gold)" }} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-mut">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: "var(--ac)" }} />متاح</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: "var(--gold)" }} />محجوز في بحث جارٍ · {pointsAr(stats.held)}</span>
            </div>
          </div>
          <div className="flex flex-col justify-between gap-2 rounded-[20px] border border-ln bg-sf p-4">
            <p className="m-0 text-xs text-mut">محجوز ومُحرَّر هذا الشهر</p>
            <p className="m-0 text-2xl font-medium text-ink">{formatAr(stats.releasedHold)}</p>
            <p className="m-0 text-[11px] text-fnt">حجز مؤقت رُفع ولم يُخصم، من {searchesAr(stats.releasedJobs)}</p>
          </div>
          <div className="flex flex-col justify-between gap-2 rounded-[20px] border border-ln bg-sf p-4">
            <p className="m-0 text-xs text-mut">خُصم هذا الشهر</p>
            <p className="m-0 text-2xl font-medium text-ink">{formatAr(stats.charged)}</p>
            <p className="m-0 text-[11px] text-fnt">على {formatAr(monthRows)} سجلًا مسلَّمًا</p>
          </div>
        </div>

        <div className="mt-2.5 flex flex-col gap-2.5 rounded-[20px] bg-sf2 px-4 py-3.5">
          <p className="m-0 text-xs font-semibold text-ink2">رصيدك يكفي تقريبًا لـ</p>
          <div className="grid grid-cols-3 gap-2">
            {ILLUSTRATIVE_SEARCH_PRICES.map((p) => (
              <div key={p.records} className="rounded-[14px] bg-sf px-3 py-2.5">
                <p className="m-0 text-xl font-semibold text-ink">{available === null ? "—" : formatAr(Math.floor(available / p.points))}</p>
                <p className="mb-0 mt-0.5 text-[11px] leading-[1.5] text-mut">{p.label}</p>
              </div>
            ))}
          </div>
        </div>

        <PromoCodeBox onRedeemed={() => { void refreshBalance(); void loadLedger(); }} />

        <div ref={formRef} data-topup-form="1" />
        {!submitted ? (
          <TopupForm
            amount={amount}
            onAmount={setAmount}
            creditValue={creditValue}
            ipa={ipa}
            loadingIpa={loadingIpa}
            ipaLoadFailed={ipaLoadFailed}
            pendingCount={pendingCount}
            maxPending={maxPending}
            onSubmitted={(t) => { setSubmitted(t); setTopups((prev) => [t, ...prev.filter((x) => x.$id !== t.$id)]); setTimeout(() => document.querySelector("[data-topup-card]")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60); }}
          />
        ) : (
          <SubmittedCard topup={displaySubmitted || submitted} creditValue={creditValue} onBack={() => setSubmitted(null)} onContinue={() => router.push(returnTo.current)} />
        )}

        {topups.length > 0 && (
          <div className="mt-10">
            <h3 className="mb-1.5 mt-0 text-[15px] font-medium text-ink">طلبات الشحن</h3>
            {displayTopups.map((t) => {
              const b = statusBadge(t.status);
              const pts = t.status === "approved" ? t.credits : Math.floor(t.amountEgp / creditValue);
              return (
                <div key={t.$id} className="flex items-center gap-3.5 border-b border-ln py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-[15px] text-ink">{formatAr(t.amountEgp)} ج.م{pts === null ? "" : ` · ${pointsAr(pts)}`}</p>
                    <p className="mb-0 mt-[3px] truncate text-xs font-light text-fnt">{TOPUP_REQUEST_LABEL_AR} · {formatDate(t.createdAt)}، {formatTime(t.createdAt)}</p>
                    {t.status === "rejected" && t.rejectReason && <p className="mb-0 mt-1.5 text-xs leading-[1.7] text-bad">سبب الرفض: {t.rejectReason}</p>}
                  </div>
                  <span className="shrink-0 rounded-full px-3 py-1 text-xs font-medium" style={{ background: b.bg, color: b.fg }}>{USER_STATUS[t.status]}</span>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-7">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2.5">
            <h3 className="m-0 text-[15px] font-semibold text-ink">سجل الحركات</h3>
            <div className="no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-full bg-sf2 p-[3px]" role="tablist">
              {LEDGER_TABS.map(([id, label]) => {
                const on = ledFilter === id;
                return (
                  <button
                    key={id} type="button" role="tab" aria-selected={on} onClick={() => setLedFilter(id)}
                    className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-full border-0 px-3 text-xs font-medium"
                    style={{ background: on ? "var(--sf)" : "transparent", color: on ? "var(--ink)" : "var(--mut)", boxShadow: on ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          {ledgerFailed && <p role="alert" className="text-[13px] text-bad">تعذّر تحميل سجل الحركات الآن.</p>}
          {visibleLedger.map((l) => {
            const k = kindOf(l);
            const ico = k === "topup" ? [UI.wallet, "var(--ok)"] : k === "refund" ? [UI.refund, "var(--goldT)"] : ["M5 12h14", "var(--ink2)"];
            const tint = k === "topup" ? "var(--ok)" : k === "refund" ? "var(--gold)" : "var(--mut)";
            const plus = l.delta > 0;
            return (
              <div key={l.$id} className="flex items-center gap-3 border-b border-ln py-3">
                <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[11px]" style={{ background: `color-mix(in oklab, ${tint} 12%, transparent)`, color: ico[1] }}><Icon d={ico[0]} size={16} stroke={1.8} /></span>
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-sm text-ink">{ledgerLabel(l)}</p>
                  <p className="mb-0 mt-[3px] truncate text-xs font-light text-fnt">{walletNoteForDisplay(l.note) ? `${walletNoteForDisplay(l.note)} · ` : ""}{new Intl.DateTimeFormat("ar-EG-u-nu-arab", { day: "numeric", month: "long" }).format(new Date(l.createdAt))}</p>
                </div>
                <span dir="ltr" className="text-[15px] font-semibold" style={{ color: plus ? "var(--goldT)" : "var(--ink)" }}>{plus ? "+" : "−"}{formatAr(Math.abs(l.delta))}</span>
              </div>
            );
          })}
          {!ledgerFailed && !ledgerLoaded && <p className="py-6 text-center text-[13px] font-light text-fnt">جارٍ تحميل الحركات…</p>}
          {!ledgerFailed && ledgerLoaded && visibleLedger.length === 0 && <p className="py-6 text-center text-[13px] font-light text-fnt">لا توجد حركات بعد.</p>}
        </div>
      </div>
    </div>
  );
}
