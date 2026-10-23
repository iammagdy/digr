"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { toArabicDigits } from "@/lib/arabicDigits";
import type { ProviderLimitsState } from "@/lib/server/providerLimitsAdmin";
import { dateTimeAr, tint } from "./format";

const SECTION = "flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4";
const FIELD = "min-h-[46px] w-full rounded-xl border border-ln bg-bg px-3.5 text-sm text-ink outline-none text-left";
const MONO = { fontFamily: "ui-monospace,monospace" } as const;
const BTN = "min-h-11 cursor-pointer whitespace-nowrap rounded-full border border-ln2 bg-sf px-4 text-xs text-ink";

const usd = (n: number) => `${toArabicDigits(n >= 1e6 ? n.toExponential(2) : n.toFixed(n < 1 ? 4 : 2).replace(/\.?0+$/, "") || "0")} دولار`;
const pct = (n: number) => `${toArabicDigits(Math.round(n))}٪`;
const asText = (n: number | null) => (n === null ? "" : String(n));

/** The banner shown in the tab (and reused by the admin home): a warning at the threshold, a plain message at the limit. */
export function SpendLimitBanner({ level, percent, label }: { level: "ok" | "warn" | "reached"; percent: number; label: string }) {
  if (level === "ok") return null;
  const bad = level === "reached";
  return (
    <p role="alert" className="m-0 rounded-[14px] px-3.5 py-3 text-[13px] font-semibold leading-[1.8]" style={{ background: tint(bad ? "var(--bad)" : "var(--gold)", bad ? 11 : 16), color: bad ? "var(--bad)" : "var(--ink)" }}>
      {bad
        ? `${label}: وصل الإنفاق اليوم إلى الحد المسموح، فلن تبدأ طلبات جديدة تحتاجه حتى يُرفع الحد أو يبدأ يوم جديد.`
        : `${label}: وصل الإنفاق اليوم إلى ${pct(percent)} من الحد اليومي.`}
    </p>
  );
}

/**
 * Editable spend limits for one provider. Values apply at once on the server that saves (30 s elsewhere), with no
 * redeploy. Before the database update is applied the fields are read-only and the tab says so.
 */
type ExtraCaps = Record<"firecrawl" | "contextdev", { dailyUsd: number; todayUsd: number | null }>;
const EXTRA_KEY = { firecrawl: "firecrawlDailyUsd", contextdev: "contextdevDailyUsd" } as const;

export function ProviderLimitsPanel({ provider, balanceUsd, onSaved }: { provider: "treg" | "anthropic" | "firecrawl" | "contextdev"; balanceUsd?: number | null; onSaved?: () => void }) {
  const [state, setState] = useState<ProviderLimitsState | null>(null);
  const [extra, setExtra] = useState<ExtraCaps | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [daily, setDaily] = useState("");
  const [perJob, setPerJob] = useState("");
  const [perUser, setPerUser] = useState("");
  const [warn, setWarn] = useState("");
  const [llmDaily, setLlmDaily] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await adminFetch<{ state: ProviderLimitsState; extra?: ExtraCaps }>("/api/admin/provider-limits");
      setState(r.state);
      setExtra(r.extra ?? null);
      setDaily(provider === "firecrawl" || provider === "contextdev" ? String(r.extra?.[provider]?.dailyUsd ?? 0) : String(r.state.limits.dailyUsd));
      setPerJob(asText(r.state.limits.perJobUsd));
      setPerUser(asText(r.state.limits.perUserDailyUsd));
      setWarn(String(r.state.limits.warnPercent));
      setLlmDaily(String(r.state.limits.llmDailyUsd));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحميل الحدود.");
    }
  }, [provider]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (busy || !state) return;
    setBusy(true); setMsg(null);
    const limits = provider === "treg"
      ? { dailyUsd: daily, perJobUsd: perJob, perUserDailyUsd: perUser, warnPercent: warn }
      : provider === "firecrawl" || provider === "contextdev"
      ? { [EXTRA_KEY[provider]]: daily, warnPercent: warn }
      : { llmDailyUsd: llmDaily, warnPercent: warn };
    try {
      const r = await adminFetch<{ success: boolean; message: string }>("/api/admin/provider-limits", { method: "POST", body: JSON.stringify({ limits }) });
      setMsg({ ok: true, text: r.message });
      await load();
      onSaved?.();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "تعذر حفظ الحدود." });
    } finally { setBusy(false); }
  };

  if (error && !state) return <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>;
  if (!state) return <div className="h-40 rounded-[18px] bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />;

  const isTreg = provider === "treg";
  const isExtra = provider === "firecrawl" || provider === "contextdev";
  const extraCap = isExtra ? extra?.[provider] ?? { dailyUsd: 0, todayUsd: null } : null;
  // The extra providers' level is computed here from the same two numbers (their spend is read from the cost table).
  const extraToday = extraCap?.todayUsd ?? 0;
  const extraLimit = extraCap?.dailyUsd ?? 0;
  const extraPercent = extraLimit > 0 ? Math.min(100, (extraToday / extraLimit) * 100) : extraToday > 0 ? 100 : 0;
  const extraLevel: "ok" | "warn" | "reached" = extraLimit <= 0 ? "ok" : extraToday >= extraLimit ? "reached" : extraPercent >= state.limits.warnPercent ? "warn" : "ok";
  const level = isExtra ? extraLevel : isTreg ? state.spend.level : state.spend.llmLevel;
  const percent = isExtra ? extraPercent : isTreg ? state.spend.percent : state.spend.llmPercent;
  const today = isExtra ? extraToday : isTreg ? state.spend.todayUsd : state.spend.llmTodayUsd;
  const limit = isExtra ? extraLimit : isTreg ? state.limits.dailyUsd : state.limits.llmDailyUsd;
  const readOnly = !state.storeReady;

  return (
    <section className={SECTION} aria-label="حدود الإنفاق">
      <h3 className="m-0 text-[15px] font-semibold text-ink">{isTreg ? "حدود إنفاق مزود البيانات" : isExtra ? "الحد اليومي لإنفاق هذا المزود" : "الحد اليومي للنموذج الذكي"}</h3>
      {!state.storeReady && state.noticesAr[0] && (
        <p role="status" className="m-0 rounded-[14px] px-3.5 py-3 text-[13px] leading-[1.8] text-ink" style={{ background: tint("var(--gold)", 14) }}>{state.noticesAr[0]}</p>
      )}
      {isExtra && extraLimit <= 0 && (
        <p role="status" className="m-0 rounded-[14px] px-3.5 py-3 text-[13px] leading-[1.8] text-ink" style={{ background: tint("var(--gold)", 14) }}>لم يُضبط حد يومي لهذا المزود بعد (الصفر يعني: لا يُسمح بأي إنفاق). حدّد رقمًا ثم احفظ.</p>
      )}
      <SpendLimitBanner level={level} percent={percent} label={isTreg ? "مزود البيانات" : isExtra ? "هذا المزود" : "النموذج الذكي"} />

      <div className="grid gap-2 text-xs sm:grid-cols-3">
        <div className="rounded-xl bg-sf p-3"><p className="m-0 text-mut">إنفاق اليوم المسجّل</p><p className="mb-0 mt-1 text-[15px] font-semibold text-ink">{usd(today)}</p></div>
        <div className="rounded-xl bg-sf p-3"><p className="m-0 text-mut">نسبة الحد اليومي</p><p className="mb-0 mt-1 text-[15px] font-semibold text-ink">{pct(percent)} من {usd(limit)}</p></div>
        {isTreg && <div className="rounded-xl bg-sf p-3"><p className="m-0 text-mut">رصيدك الحقيقي لدى المزود</p><p className="mb-0 mt-1 text-[15px] font-semibold text-ink">{typeof balanceUsd === "number" ? usd(balanceUsd) : "غير متاح"}</p></div>}
      </div>

      {isExtra ? (
        <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">الحد اليومي لإنفاق هذا المزود (دولار)</span><input type="text" inputMode="decimal" dir="ltr" disabled={readOnly || busy} value={daily} onChange={(e) => setDaily(e.target.value)} className={FIELD} style={MONO} /></label>
      ) : isTreg ? (
        <>
          <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">الحد اليومي لإنفاق المزود (دولار)</span><input type="text" inputMode="decimal" dir="ltr" disabled={readOnly || busy} value={daily} onChange={(e) => setDaily(e.target.value)} className={FIELD} style={MONO} /></label>
          <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">سقف المزود لكل طلب (دولار، اتركه فارغًا لعدم التحديد)</span><input type="text" inputMode="decimal" dir="ltr" disabled={readOnly || busy} value={perJob} onChange={(e) => setPerJob(e.target.value)} className={FIELD} style={MONO} /></label>
          <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">سقف المزود اليومي لكل مستخدم (دولار، فارغ = بلا سقف)</span><input type="text" inputMode="decimal" dir="ltr" disabled={readOnly || busy} value={perUser} onChange={(e) => setPerUser(e.target.value)} className={FIELD} style={MONO} /></label>
        </>
      ) : (
        <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">الحد اليومي لإنفاق النموذج الذكي (دولار)</span><input type="text" inputMode="decimal" dir="ltr" disabled={readOnly || busy} value={llmDaily} onChange={(e) => setLlmDaily(e.target.value)} className={FIELD} style={MONO} /></label>
      )}
      <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">نسبة التنبيه من الحد اليومي (٪)</span><input type="text" inputMode="decimal" dir="ltr" disabled={readOnly || busy} value={warn} onChange={(e) => setWarn(e.target.value)} className={FIELD} style={MONO} /></label>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={readOnly || busy} onClick={() => void save()} className={BTN} style={{ opacity: readOnly ? 0.5 : 1 }}>{busy ? "جارٍ الحفظ…" : "حفظ الحدود"}</button>
        <span className="text-[11px] text-fnt">المصدر الحالي: {state.source === "settings" ? "الإعدادات المحفوظة" : state.source === "legacy" ? "إعدادات التسعير القديمة" : "القيم الافتراضية"}</span>
      </div>
      {msg && <p role="status" aria-live="polite" className="m-0 text-[13px] leading-[1.8]" style={{ color: msg.ok ? "var(--ok)" : "var(--bad)" }}>{msg.text}</p>}
      <p className="m-0 text-[11px] leading-[1.7] text-fnt">تسري الحدود فورًا على الخادم الذي يحفظ، وخلال ٣٠ ثانية على الباقي، بلا إعادة نشر. رقم كبير جدًا يلغي الحد عمليًا، والصفر يوقف كل الإنفاق.</p>

      {state.audit.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-ln pt-2">
          <p className="m-0 text-xs font-semibold text-mut">آخر التعديلات</p>
          {state.audit.map((a, i) => <p key={i} className="m-0 text-[11px] leading-[1.7] text-ink">{dateTimeAr(a.at)} — {toArabicDigits(a.summaryAr)}</p>)}
        </div>
      )}
    </section>
  );
}
