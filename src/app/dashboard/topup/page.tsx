"use client";

import { pointsAr } from "@/lib/pointsFormat";
import { egpToPoints } from "@/lib/topupAmount";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/hooks/useUser";
import { useBalance } from "@/hooks/useBalance";
import { useCreditValue } from "@/hooks/useCreditValue";
import { Icon, UI } from "@/components/app/icons";
import { balanceText, formatDate, formatTime, isIpaAvailable } from "@/lib/honestDisplay";
import { formatAr } from "@/lib/arabicDigits";
import { CREDIT_LEDGER_COLLECTION, JOBS_COLLECTION, NOTIFICATIONS_COLLECTION, SETTINGS_PUBLIC_COLLECTION, TOPUPS_COLLECTION } from "@/lib/constants";
import { notificationIdForTopup, rejectionReasonFor, topupIdFromNotificationId } from "@/lib/topupRejectReason";
import { capacityForPoints } from "@/lib/pricingPage";
import { Skeleton } from "@/components/ui";
import { startNotificationPolling } from "@/lib/notificationPolling";
import { getSlowFactor } from "@/lib/degradedClient";
import SubmittedCard from "./SubmittedCard";
import TopupForm from "./TopupForm";
import { RejectionReasonLine } from "./RejectionReasonLine";
import PromoCodeBox from "./PromoCodeBox";
import { CREDIT_KIND_LABEL_AR, classifyLedgerRow } from "@/lib/creditKinds";
import { TOPUP_REQUEST_LABEL_AR, walletDisplayText, walletNoteForDisplay } from "@/lib/walletText";
import { creditedPointsByTopup, creditedPointsOf, groupMissionRows, kindOfLedgerRow as kindOf, visibleLedgerRows, walletMonthStats, type WalletLedgerKind as LedgerKind } from "@/lib/walletView";
import { statusBadge, USER_STATUS, type LedgerRow, type TopupRecord } from "./types";

const ledgerLabel = (row: LedgerRow): string => walletDisplayText(row.labelAr || CREDIT_KIND_LABEL_AR[classifyLedgerRow({ type: row.type, kind: row.kind })]);
const LEDGER_TABS: Array<["all" | LedgerKind, string]> = [["all", "الكل"], ["topup", "شحن"], ["charge", "خصم وحجز"], ["refund", "حجز مُحرَّر"]];

/** The three estimate chips of the balance card: the records the balance delivers, by kind. */
const CAPACITY_CHIP_AR: Record<string, string> = { "youtube-comments": "تعليق يوتيوب", "x-posts": "منشور إكس", companies: "شركة" };

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

/** One ledger row, exactly as the wallet always showed it (the rows of a mission are the same rows, listed inside its group). */
function LedgerLine({ l, compact = false }: { l: LedgerRow; compact?: boolean }) {
  const k = kindOf(l);
  const ico = k === "topup" ? [UI.wallet, "var(--ok)"] : k === "refund" ? [UI.refund, "var(--goldT)"] : ["M5 12h14", "var(--ink2)"];
  const tint = k === "topup" ? "var(--ok)" : k === "refund" ? "var(--gold)" : "var(--mut)";
  const plus = l.delta > 0;
  return (
    <div className={`flex items-center gap-3 border-t border-ln ${compact ? "px-3 py-2 first:border-t-0" : "px-5 py-3 first:border-t-0"}`}>
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[11px]" style={{ background: `color-mix(in oklab, ${tint} 12%, transparent)`, color: ico[1] }}><Icon d={ico[0]} size={16} stroke={1.8} /></span>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-sm text-ink">{ledgerLabel(l)}</p>
        <p className="mb-0 mt-[3px] text-xs font-light leading-[1.7] text-fnt">{walletNoteForDisplay(l.note) ? `${walletNoteForDisplay(l.note)} · ` : ""}{new Intl.DateTimeFormat("ar-EG-u-nu-arab", { day: "numeric", month: "long" }).format(new Date(l.createdAt))}</p>
      </div>
      <span dir="ltr" className="text-[15px] font-semibold" style={{ color: plus ? "var(--ok)" : "var(--ink)" }}>{plus ? "+" : "−"}{formatAr(Math.abs(l.delta))}</span>
    </div>
  );
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
  const [monthRows, setMonthRows] = useState<number | null>(null);
  // the notification text of each rejected request (the customer reads their own notifications): where the reason lives, see loadRejectNotes below
  const [rejectNotes, setRejectNotes] = useState<Record<string, string>>({});
  const [ledFilter, setLedFilter] = useState<"all" | LedgerKind>("all");
  const [queryEgp, setQueryEgp] = useState<number | null>(null);
  // the chat sends the shortfall in EGP; the form works in points, so it starts from the points that amount buys (the form keeps it inside the limits)
  const initialPoints = queryEgp === null ? undefined : egpToPoints(queryEgp, creditValue);
  const [submitted, setSubmitted] = useState<TopupRecord | null>(null);
  const [ipa, setIpa] = useState<string | null>(isIpaAvailable(ipaFromEnv) ? ipaFromEnv! : null);
  const [loadingIpa, setLoadingIpa] = useState(!isIpaAvailable(ipaFromEnv));
  const [ipaLoadFailed, setIpaLoadFailed] = useState(false);
  const [maxPending, setMaxPending] = useState(3);
  const [reviewTimeAr, setReviewTimeAr] = useState<string | null>(null);
  const [paymentLabelAr, setPaymentLabelAr] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef("/dashboard/chat");

  /* ?amount=…&return=… from the chat's «اشحن {الفرق} والعودة هنا» */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const a = Number(q.get("amount"));
    if (Number.isFinite(a) && a > 0) setQueryEgp(a);
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
          const d = (data?.value || {}) as { ipa?: string; maxPendingTopups?: number; reviewTimeAr?: string; paymentLabelAr?: string };
          if (isIpaAvailable(d.ipa)) setIpa(d.ipa!.trim());
          if (Number.isInteger(d.maxPendingTopups) && d.maxPendingTopups! > 0) setMaxPending(d.maxPendingTopups!);
          if (typeof d.reviewTimeAr === "string" && d.reviewTimeAr.trim()) setReviewTimeAr(d.reviewTimeAr.trim());
          if (typeof d.paymentLabelAr === "string" && d.paymentLabelAr.trim()) setPaymentLabelAr(d.paymentLabelAr.trim().slice(0, 80));
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
          jobId: r.jobId, missionLineAr: r.missionLineAr ?? null, topupId: r.topupId, note: r.note || "", createdAt: r.createdAt,
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

  /* The reason of a rejected request. The top-up row has no reason column; the reject route writes the reason into the customer's own notification
     (id notif_<request id>, readable by them under the notifications policy), so one read-only query of those rows is all it takes. No timer: it runs
     when the set of rejected requests changes (a pending request the admin rejects while the page polls included). */
  const rejectedKey = topups.filter((t) => t.status === "rejected").map((t) => t.$id).join(",");
  useEffect(() => {
    if (!user || !rejectedKey) return;
    let active = true;
    (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from(NOTIFICATIONS_COLLECTION)
          .select("id, body")
          .eq("user_id", user.id)
          .in("id", rejectedKey.split(",").map(notificationIdForTopup));
        if (!active) return;
        const next: Record<string, string> = {};
        for (const row of data || []) if (typeof row?.id === "string" && typeof row?.body === "string") next[topupIdFromNotificationId(row.id)] = row.body;
        setRejectNotes(next);
      } catch { /* no reason is shown: never a placeholder */ }
    })();
    return () => { active = false; };
  }, [user, rejectedKey]);

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
  // The month figures wait for the ledger: «٠» is never shown for numbers that have not arrived (a failed load says so elsewhere).
  const monthReady = ledgerLoaded;

  const available = balance.status === "ready" ? balance.value! : null;
  const pendingCount = topups.filter((t) => t.status === "pending").length;
  /* points an approved top-up credited, read from its ledger row (approve_topup_atomic writes it as top_<id> with no topup_id) */
  const creditsByTopup = creditedPointsByTopup(ledger);
  /* the reason is cleaned and only ever set on a REJECTED request (approved and pending requests never carry one) */
  const reasonOf = (topup: TopupRecord) => rejectionReasonFor({ status: topup.status, columnReason: topup.rejectReason, notificationBody: rejectNotes[topup.$id] });
  const displayTopups = topups.map((topup) => ({ ...topup, credits: creditedPointsOf(topup, creditsByTopup), rejectReason: reasonOf(topup) }));
  const displaySubmitted = submitted ? { ...submitted, credits: creditedPointsOf(submitted, creditsByTopup), rejectReason: reasonOf(submitted) } : null;

  const visibleLedger = visibleLedgerRows(ledger, ledFilter);

  const scrollToForm = () => {
    setSubmitted(null);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  return (
    <div data-screen-label="Wallet" className="flex-1">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-7 px-6 pb-16 pt-9">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="m-0 text-[32px] font-bold leading-[1.2] text-ac">المحفظة</h1>
            <p className="mb-0 mt-1.5 text-sm text-mut">النقطة الواحدة = {formatAr(creditValue, 2)} ج.م · تدفع على ما يُسلَّم لك فقط</p>
          </div>
          <button type="button" onClick={scrollToForm} className="min-h-11 cursor-pointer whitespace-nowrap rounded-full border-0 bg-ac px-[18px] text-sm font-semibold text-onac">+ شحن الرصيد</button>
        </div>

        <section data-testid="wallet-balance-card" className="flex flex-col gap-5 rounded-[24px] bg-wallet-card p-5 text-white min-[480px]:p-6">
          <div className="flex flex-wrap items-stretch gap-x-6 gap-y-4">
            <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-3">
              <span className="text-[13px] text-wallet-ondark-mut">متاح للاستخدام</span>
              <p className="m-0 flex flex-wrap items-baseline gap-2.5">
                <span className="text-[56px] font-bold leading-none tracking-[-1px]">{balance.status === "failed" ? "غير متاح" : balanceText(balance)}</span>
                <span className="text-base text-wallet-ondark">نقطة</span>
              </p>
              {available !== null && (
                <div><span className="inline-block rounded-full bg-wallet-pill px-3.5 py-1 text-[15px] font-semibold">≈ {formatAr(Number((available * creditValue).toFixed(2)))} ج.م</span></div>
              )}
              <div className="mt-auto flex flex-col gap-2" data-testid="wallet-capacity">
                <p className="m-0 text-xs text-wallet-ondark-faint">رصيدك يكفي تقريبًا لـ</p>
                <div className="flex flex-wrap gap-1.5">
                  {(available === null ? [] : capacityForPoints(available).filter((line) => line.id in CAPACITY_CHIP_AR)).map((line) => (
                    <span key={line.id} className="rounded-full bg-wallet-deep px-3 py-1 text-[13px] text-wallet-ondark"><b className="text-white">{formatAr(line.records)}</b> {CAPACITY_CHIP_AR[line.id]}</span>
                  ))}
                  {available === null && [0, 1, 2].map((slot) => <Skeleton key={slot} className="h-7 w-28 !rounded-full !bg-none bg-white/10" />)}
                </div>
              </div>
            </div>

            <div className="flex min-w-0 flex-[1_1_220px] flex-col rounded-[18px] bg-wallet-deep px-4 pb-1 pt-1.5" data-testid="wallet-released-month">
              <p className="m-0 pb-0.5 pt-2.5 text-xs text-wallet-ondark-faint">هذا الشهر</p>
              <div className="flex items-center justify-between gap-3 border-b border-wallet-line py-3">
                <div className="min-w-0">
                  <p className="m-0 flex items-center gap-2 whitespace-nowrap text-[13px] text-wallet-ondark"><span className="h-2 w-2 shrink-0 rounded-full bg-wallet-amber" />محجوز ومُحرَّر</p>
                  <p className="mb-0 mt-1 text-[11px] leading-[1.6] text-wallet-ondark-faint">{monthReady ? `حجز مؤقت رُفع ولم يُخصم، من ${searchesAr(stats.releasedJobs)}` : ledgerFailed ? "تعذّر تحميل الأرقام" : "حجز مؤقت رُفع ولم يُخصم"}</p>
                </div>
                {monthReady ? <p className="m-0 text-xl font-bold text-wallet-amber">{formatAr(stats.releasedHold)}</p> : ledgerFailed ? <p className="m-0 text-xl font-bold text-white">—</p> : <Skeleton className="h-7 w-16 !bg-none bg-white/10" />}
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-wallet-line py-3">
                <div className="min-w-0">
                  <p className="m-0 flex items-center gap-2 whitespace-nowrap text-[13px] text-wallet-ondark"><span className="h-2 w-2 shrink-0 rounded-full bg-wallet-dot" />خُصم</p>
                  <p className="mb-0 mt-1 text-[11px] leading-[1.6] text-wallet-ondark-faint">{monthReady && monthRows !== null ? `مقابل ${formatAr(monthRows)} عنصرًا مسلَّمًا` : ledgerFailed ? "تعذّر تحميل الأرقام" : "مقابل ما سُلِّم لك"}</p>
                </div>
                {monthReady ? <p className="m-0 text-xl font-bold text-white">{formatAr(stats.charged)}</p> : ledgerFailed ? <p className="m-0 text-xl font-bold text-white">—</p> : <Skeleton className="h-7 w-16 !bg-none bg-white/10" />}
              </div>
              <div className="flex items-center justify-between gap-3 py-3">
                <p className="m-0 flex items-center gap-2 whitespace-nowrap text-[13px] text-wallet-ondark"><span className="h-2 w-2 shrink-0 rounded-full border border-wallet-ondark-faint" />محجوز في بحث جارٍ</p>
                {monthReady ? <p className="m-0 text-xl font-bold text-white">{formatAr(stats.held)}</p> : ledgerFailed ? <p className="m-0 text-xl font-bold text-white">—</p> : <Skeleton className="h-7 w-16 !bg-none bg-white/10" />}
              </div>
            </div>
          </div>

          <PromoCodeBox onRedeemed={() => { void refreshBalance(); void loadLedger(); }} />

          <div className="-mt-1.5 flex flex-col gap-1.5 text-[11px] font-light leading-[1.8] text-wallet-ondark-faint">
            <p className="m-0">الأرقام تقدير بسعر السجل المُسلَّم نفسه، دون احتياطي الحجز؛ وسعر خطتك الدقيق يظهر قبل أن توافق.</p>
            {monthReady && stats.releasedGross > 0 ? (
              <p data-testid="wallet-released-explainer" className="m-0">
                في سجل الحركات يظهر الحجز المُحرَّر كاملًا قبل الخصم ({formatAr(stats.releasedGross)} نقطة هذا الشهر)، ثم يظهر الخصم في سطر مستقل. الرقم أعلاه هو الباقي بعد خصم ثمن ما سُلِّم، أي ما رُفع ولم يُخصم ({formatAr(stats.releasedHold)} نقطة).
              </p>
            ) : null}
          </div>
        </section>

        <div ref={formRef} id="topup" data-topup-form="1" className="-mb-7 scroll-mt-6" />
        {!submitted ? (
          <TopupForm
            initialPoints={initialPoints}
            creditValue={creditValue}
            ipa={ipa}
            loadingIpa={loadingIpa}
            ipaLoadFailed={ipaLoadFailed}
            pendingCount={pendingCount}
            maxPending={maxPending}
            reviewTimeAr={reviewTimeAr}
            paymentLabelAr={paymentLabelAr}
            onSubmitted={(t) => { setSubmitted(t); setTopups((prev) => [t, ...prev.filter((x) => x.$id !== t.$id)]); setTimeout(() => document.querySelector("[data-topup-card]")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60); }}
          />
        ) : (
          <SubmittedCard topup={displaySubmitted || submitted} creditValue={creditValue} onBack={() => setSubmitted(null)} onContinue={() => router.push(returnTo.current)} />
        )}

        {topups.length > 0 && (
          <section className="overflow-hidden rounded-[24px] border border-ln bg-sf">
            <h3 className="m-0 px-5 pb-2 pt-5 text-xl font-bold text-ac">طلبات الشحن</h3>
            {displayTopups.map((t) => {
              const b = statusBadge(t.status);
              const pts = t.status === "approved" ? t.credits : Math.floor(t.amountEgp / creditValue);
              return (
                <div key={t.$id} className="flex items-center gap-3.5 border-t border-ln px-5 py-3.5 first:border-t-0">
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-[15px] font-semibold text-ink">{formatAr(t.amountEgp)} ج.م{pts === null ? "" : ` · ${pointsAr(pts)}`}</p>
                    <p className="mb-0 mt-[3px] text-xs font-light leading-[1.7] text-fnt">{TOPUP_REQUEST_LABEL_AR} · {formatDate(t.createdAt)}، {formatTime(t.createdAt)}</p>
                    <RejectionReasonLine reason={t.status === "rejected" ? t.rejectReason ?? null : null} />
                  </div>
                  <span className="shrink-0 rounded-full px-3 py-1 text-xs font-medium" style={{ background: b.bg, color: b.fg }}>{USER_STATUS[t.status]}</span>
                </div>
              );
            })}
          </section>
        )}

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5">
            <h3 className="m-0 text-xl font-bold text-ac">سجل الحركات</h3>
            <div className="no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-full bg-sf2 p-[3px]" role="tablist">
              {LEDGER_TABS.map(([id, label]) => {
                const on = ledFilter === id;
                return (
                  <button
                    key={id} type="button" role="tab" aria-selected={on} onClick={() => setLedFilter(id)}
                    className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-full border-0 px-3.5 text-xs font-medium"
                    style={{ background: on ? "var(--sf)" : "transparent", color: on ? "var(--ink)" : "var(--mut)", boxShadow: on ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="overflow-hidden rounded-[24px] border border-ln bg-sf">
            {ledgerFailed && <p role="alert" className="m-0 px-5 py-4 text-[13px] text-bad">تعذّر تحميل سجل الحركات الآن.</p>}
            {groupMissionRows(visibleLedger).map((entry) => {
              if (entry.kind === "row") return <LedgerLine key={entry.row.$id} l={entry.row} />;
              // ONE LINE PER MISSION («خُصم ١٢٨ نقطة مقابل ١٩٢ تغريدة»), its ledger rows (the hold, the charge, the released hold) inside, collapsed
              const net = entry.rows.reduce((n, r) => n + r.delta, 0);
              const newest = entry.rows[0];
              return (
                <details key={`mission-${entry.jobId}`} className="group border-t border-ln px-5 py-3 first:border-t-0" data-testid="wallet-mission-group">
                  <summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
                    <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[11px]" style={{ background: "color-mix(in oklab, var(--mut) 12%, transparent)", color: "var(--ink2)" }}><Icon d="M5 12h14" size={16} stroke={1.8} /></span>
                    <div className="min-w-0 flex-1">
                      <p className="m-0 text-sm text-ink" data-testid="wallet-mission-line">{walletDisplayText(entry.lineAr)}</p>
                      <p className="mb-0 mt-[3px] text-xs font-light leading-[1.7] text-fnt">{new Intl.DateTimeFormat("ar-EG-u-nu-arab", { day: "numeric", month: "long" }).format(new Date(newest.createdAt))} · <span className="text-ink2 underline decoration-dotted underline-offset-4">تفاصيل الحركات</span></p>
                    </div>
                    <span dir="ltr" className="text-[15px] font-semibold" style={{ color: net > 0 ? "var(--ok)" : "var(--ink)" }}>{net > 0 ? "+" : "−"}{formatAr(Math.abs(net))}</span>
                  </summary>
                  <div className="mt-2 rounded-[14px] bg-sf2" data-testid="wallet-mission-details">{entry.rows.map((r) => <LedgerLine key={r.$id} l={r} compact />)}</div>
                </details>
              );
            })}
            {!ledgerFailed && !ledgerLoaded && <p className="m-0 px-5 py-6 text-center text-[13px] font-light text-fnt">جارٍ تحميل الحركات…</p>}
            {!ledgerFailed && ledgerLoaded && visibleLedger.length === 0 && <p className="m-0 px-5 py-6 text-center text-[13px] font-light text-fnt">لا توجد حركات بعد.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
