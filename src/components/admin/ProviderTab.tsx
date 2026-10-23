"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import type { ProviderTabState } from "@/lib/server/providerKeyAdmin";
import { agoAr, dateTimeAr, tint } from "./format";
import { ProviderLimitsPanel } from "./ProviderLimitsPanel";
import { ProviderCallLog } from "./ProviderCallLog";

type Provider = "treg" | "anthropic" | "firecrawl" | "contextdev";
/** The providers that collect data (the model provider has no call log of this kind). */
const isDataProvider = (p: Provider): p is "treg" | "firecrawl" | "contextdev" => p !== "anthropic";
/** Providers that sell credits: the balance is the provider's own credit count, not dollars. */
const isCreditProvider = (p: Provider) => p === "firecrawl" || p === "contextdev";

const SECTION = "flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4";
const FIELD = "min-h-[46px] w-full rounded-xl border border-ln bg-bg px-3.5 text-sm text-ink outline-none text-left";
const MONO = { fontFamily: "ui-monospace,monospace" } as const;
const BTN = "min-h-11 cursor-pointer whitespace-nowrap rounded-full border border-ln2 bg-sf px-4 text-xs text-ink";

const REASON_AR: Record<string, string> = {
  ok: "يعمل",
  auth_rejected: "رفض المزود المفتاح",
  rate_limited: "المزود يطلب التمهل (حد الطلبات)",
  server_error: "خطأ من جهة المزود",
  network_error: "تعذر الوصول إلى المزود (خطأ اتصال)",
  timeout: "انتهت مهلة الاتصال بالمزود",
  unexpected: "ردّ غير متوقع من المزود",
  no_key: "لا يوجد مفتاح مضبوط",
  missing_scope: "المفتاح مقبول لكن ينقصه إذن قراءة الاستخدام (logs:read)؛ يعمل المزود ولا يُعرض الرصيد",
};
const CLASS_AR: Record<string, string> = { "2xx": "نجاح (٢xx)", "3xx": "تحويل (٣xx)", "4xx": "رفض من العميل (٤xx)", "5xx": "خطأ من الخادم (٥xx)", network: "لا رد", timeout: "مهلة" };
const BALANCE_UNAVAILABLE_AR: Record<string, string> = {
  no_balance_api: "المزود لا يوفّر واجهة لقراءة الرصيد بمفتاح عادي، لذلك لا يُعرض رقم.",
  no_key: "لا يوجد مفتاح لقراءة الرصيد.",
  org_unknown: "تعذر تحديد معرّف الفريق لدى المزود. أدخله في الإعدادات أدناه لقراءة الرصيد.",
  unreadable: "ردّ المزود لا يحتوي رصيدًا يمكن قراءته، فلا يُعرض رقم.",
  check_failed: "فشل فحص الاتصال، لذلك لا يمكن قراءة الرصيد الآن.",
  missing_scope: "ينقص المفتاح إذن قراءة الاستخدام (logs:read) في لوحة المزود، لذلك لا يمكن عرض الرصيد. أعد إنشاء المفتاح بهذا الإذن إن أردت رؤية الرصيد هنا.",
};
/** Shown when the provider's own answer carries no e-mail for the connected account. */
export const ACCOUNT_EMAIL_UNAVAILABLE_AR = "الإيميل غير متاح من المزود";
const SOURCE_AR: Record<string, string> = { store: "مخزن المفاتيح المشفّر", env: "متغيرات البيئة (Vercel)", none: "غير مضبوط" };

/** Dollars with up to 4 decimals in Arabic-Indic digits. */
const usd = (n: number) => `${toArabicDigits(n.toFixed(n < 1 ? 4 : 2).replace(/\.?0+$/, "") || "0")} دولار`;

/** The connected provider account's e-mail (admin tab only), or the plain sentence when the provider's answer had none. Not the team id. */
export function AccountEmailLine({ email }: { email: string | null }) {
  return (
    <p data-testid="provider-account-email" className="m-0 text-xs text-mut">
      حساب المزود المتصل:{" "}
      {email
        ? <bdi dir="ltr" className="font-medium text-ink" style={MONO}>{email}</bdi>
        : <span className="font-medium text-ink">{ACCOUNT_EMAIL_UNAVAILABLE_AR}</span>}
    </p>
  );
}

function Spinner() {
  return <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-ln2 border-t-ink" style={{ animation: "spin .8s linear infinite" }} />;
}

export function ProviderTab({ provider, onChanged, children }: { provider: Provider; onChanged?: () => void; children?: ReactNode }) {
  const [state, setState] = useState<ProviderTabState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "refresh" | "replace" | "rollback" | "settings">("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [threshold, setThreshold] = useState("");
  const [orgId, setOrgId] = useState("");

  const load = useCallback(async (refresh: boolean) => {
    setBusy("refresh");
    try {
      const r = await adminFetch<{ state: ProviderTabState }>(`/api/admin/provider-keys?provider=${provider}${refresh ? "&refresh=1" : ""}`);
      setState(r.state);
      setThreshold(String(r.state.settings.lowBalanceThresholdUsd));
      setOrgId(r.state.settings.tregOrgId ?? "");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحميل بيانات المزود.");
    } finally { setBusy(""); }
  }, [provider]);
  useEffect(() => { void load(false); }, [load]);

  const post = async (action: "replace" | "rollback" | "settings", payload: Record<string, unknown>, which: "replace" | "rollback" | "settings") => {
    if (busy) return false;
    setBusy(which); setMsg(null);
    try {
      const r = await adminFetch<{ success: boolean; message: string }>("/api/admin/provider-keys", { method: "POST", body: JSON.stringify({ action, provider, ...payload }) });
      setMsg({ ok: true, text: r.message });
      await load(true);
      onChanged?.();
      return true;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "تعذر تنفيذ الطلب." });
      return false;
    } finally { setBusy(""); }
  };

  if (error && !state) return <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>;
  if (!state) return <div className="h-72 rounded-[18px] bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />;

  const h = state.status.health;
  const b = state.status.balance;
  const healthColor = h.ok ? "var(--ok)" : "var(--bad)";
  const capPct = state.spend.capUsd ? Math.min(100, (state.spend.todayUsd / state.spend.capUsd) * 100) : 0;
  const canReplace = state.store.ready && state.encryptionConfigured;

  return (
    <div className="flex flex-col gap-3.5">
      {state.noticesAr.map((n) => (
        <p key={n} role="status" className="m-0 rounded-[14px] px-3.5 py-3 text-[13px] leading-[1.8] text-ink" style={{ background: tint("var(--gold)", 14) }}>{n}</p>
      ))}

      {/* Real status: an authenticated call, not a flag */}
      <section className={SECTION} aria-label="حالة الاتصال الحقيقية">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: healthColor }} />
            <h3 className="m-0 text-[15px] font-semibold text-ink">{h.ok ? "الاتصال سليم" : "الاتصال غير سليم"}</h3>
          </div>
          <button type="button" onClick={() => void load(true)} disabled={busy !== ""} className={BTN}>
            {busy === "refresh" ? <span className="inline-flex items-center gap-2"><Spinner />جارٍ التحديث</span> : "تحديث الآن"}
          </button>
        </div>
        <div className="border-t border-ln pt-1.5 text-xs">
          {[
            ["نتيجة الفحص", REASON_AR[h.reason] ?? h.reason, healthColor],
            ["رمز الاستجابة", h.httpStatus ? `${toArabicDigits(h.httpStatus)} · ${CLASS_AR[h.statusClass] ?? h.statusClass}` : (CLASS_AR[h.statusClass] ?? "—"), "var(--ink)"],
            ["زمن الاستجابة", h.latencyMs == null ? "—" : `${formatAr(h.latencyMs)} مللي ثانية`, "var(--ink)"],
            ["وقت آخر فحص", `${dateTimeAr(h.checkedAt)} · ${agoAr(h.checkedAt)}`, "var(--ink)"],
          ].map(([k, v, c]) => (
            <div key={k} className="flex min-h-10 items-center justify-between gap-3 border-b border-ln"><span className="text-mut">{k}</span><span className="font-medium" style={{ color: c }}>{v}</span></div>
          ))}
        </div>
        <p className="m-0 text-[11px] leading-[1.7] text-fnt">الفحص طلب حقيقي بمفتاح المزود الفعلي، بدون أي تكلفة، ويُحفظ نتيجته ٦٠ ثانية على كل خادم. زر «تحديث الآن» يتجاوز ذلك.</p>
      </section>

      {/* Real balance (data provider only: the model provider has no balance API for a regular key) */}
      <section className={SECTION} aria-label="الرصيد">
        <h3 className="m-0 text-[15px] font-semibold text-ink">{provider === "treg" || isCreditProvider(provider) ? "الرصيد لدى المزود" : "الرصيد"}</h3>
        {isCreditProvider(provider) ? (
          b.available && typeof b.credits === "number" ? (
            <div className="flex flex-col gap-1" data-testid="provider-credits">
              <p className="m-0 text-[28px] font-semibold text-ink">{formatAr(b.credits)} <span className="text-[13px] font-normal text-mut">رصيد (كريدت)</span></p>
              {typeof b.planCredits === "number" && <p className="m-0 text-xs text-mut">رصيد الباقة: {formatAr(b.planCredits)}</p>}
              {typeof b.creditsUsedThisPeriod === "number" && <p className="m-0 text-xs text-mut">المستهلك في الفترة الحالية: {formatAr(b.creditsUsedThisPeriod)}</p>}
              {b.periodEndsAt && <p className="m-0 text-xs text-mut">{provider === "firecrawl" ? "نهاية الفترة الحالية" : "موعد التجديد القادم"}: {dateTimeAr(b.periodEndsAt)}</p>}
              <p className="m-0 text-xs text-mut">جُلب من المزود: {dateTimeAr(b.checkedAt)} · {agoAr(b.checkedAt)}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1" data-testid="provider-credits-unavailable">
              <p className="m-0 text-[22px] font-semibold text-ink">غير متاح</p>
              <p className="m-0 text-[13px] leading-[1.8] text-mut">{BALANCE_UNAVAILABLE_AR[b.unavailableReason ?? "check_failed"]}</p>
            </div>
          )
        ) : b.available && typeof b.balanceUsd === "number" ? (
          <div className="flex flex-col gap-1">
            <p className="m-0 text-[28px] font-semibold text-ink" style={{ color: state.lowBalance ? "var(--bad)" : undefined }}>{usd(b.balanceUsd)}</p>
            <p className="m-0 text-xs text-mut">بوحدة المزود: {toArabicDigits(b.balanceMicro ?? 0)} ميكرو دولار (واحد من مليون)</p>
            {typeof b.heldMicro === "number" && <p className="m-0 text-xs text-mut">محجوز لطلبات جارية: {toArabicDigits(b.heldMicro)} ميكرو دولار</p>}
            <p className="m-0 text-xs text-mut">آخر تحديث: {dateTimeAr(b.checkedAt)} · {agoAr(b.checkedAt)}</p>
            {state.lowBalance && <p role="alert" className="m-0 mt-1 rounded-xl px-3 py-2.5 text-[13px] leading-[1.8] text-bad" style={{ background: tint("var(--bad)", 10) }}>الرصيد أقل من حد التنبيه ({usd(state.settings.lowBalanceThresholdUsd)}). اشحن حسابك لدى المزود قبل أن تتوقف المهام.</p>}
          </div>
        ) : (
          <p className="m-0 text-[13px] leading-[1.8] text-mut">{BALANCE_UNAVAILABLE_AR[b.unavailableReason ?? "check_failed"]}</p>
        )}
        {provider === "treg" && <AccountEmailLine email={state.accountEmail} />}
        {provider === "treg" && (
          <div className="flex flex-col gap-2 border-t border-ln pt-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-mut">حد تنبيه الرصيد المنخفض (دولار)</span>
              <input type="text" inputMode="decimal" dir="ltr" value={threshold} onChange={(e) => setThreshold(e.target.value)} className={FIELD} style={MONO} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-mut">معرّف الفريق لدى المزود (اختياري، يُقرأ تلقائيًا إن أمكن)</span>
              <input type="text" dir="ltr" value={orgId} onChange={(e) => setOrgId(e.target.value)} className={FIELD} style={MONO} />
            </label>
            <div><button type="button" disabled={busy !== ""} onClick={() => void post("settings", { lowBalanceThresholdUsd: threshold, tregOrgId: orgId }, "settings")} className={BTN}>حفظ الإعدادات</button></div>
          </div>
        )}
      </section>

      {/* Platform's own recorded spend today (read-only) against the cap */}
      <section className={SECTION} aria-label="استهلاك اليوم">
        <h3 className="m-0 text-[15px] font-semibold text-ink">{provider === "treg" ? "استهلاك المنصة من المزود اليوم" : isCreditProvider(provider) ? "استهلاك المنصة من هذا المزود اليوم" : "إنفاق النموذج الذكي اليوم"}</h3>
        <p className="m-0 text-[13px] text-ink">{usd(state.spend.todayUsd)} من {state.spend.capUsd == null ? "—" : usd(state.spend.capUsd)} <span className="text-mut">({provider === "treg" || isCreditProvider(provider) ? "السقف اليومي للمزود" : "السقف اليومي العام"})</span></p>
        <div className="h-2 overflow-hidden rounded-full bg-sf2" role="progressbar" aria-valuenow={Math.round(capPct)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full" style={{ width: `${capPct}%`, background: capPct >= 90 ? "var(--bad)" : "var(--gold)" }} />
        </div>
        <p className="m-0 text-[11px] text-fnt">مسجّل من جدول التكاليف الداخلي للمنصة (قراءة فقط)، وليس رصيد المزود.</p>
      </section>

      <ProviderLimitsPanel provider={provider} balanceUsd={provider === "treg" && b.available && typeof b.balanceUsd === "number" ? b.balanceUsd : null} onSaved={() => { void load(true); onChanged?.(); }} />

      {children}

      {/* Key management: masked only, validated before saving, one-step rollback */}
      <section className={SECTION} aria-label="المفتاح">
        <h3 className="m-0 text-[15px] font-semibold text-ink">مفتاح الوصول</h3>
        <div className="flex min-h-[46px] items-center gap-2 rounded-xl border border-ln bg-sf ps-3.5 pe-3.5">
          <span dir="ltr" className="flex-1 text-left text-sm text-ink" style={MONO}>{state.maskedKey}</span>
          <span className="text-[11px] text-mut">المصدر: {SOURCE_AR[state.keySource]}</span>
        </div>
        {state.store.ready && state.store.activeSetAt && <p className="m-0 text-xs text-mut">آخر تغيير للمفتاح المحفوظ: {dateTimeAr(state.store.activeSetAt)}</p>}
        {!editing ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!canReplace || busy !== ""} onClick={() => { setEditing(true); setDraft(""); setMsg(null); }} className={BTN} style={{ opacity: canReplace ? 1 : 0.5 }}>استبدال المفتاح</button>
            {state.store.previousLast4 && (
              <button type="button" disabled={!canReplace || busy !== ""} onClick={() => void post("rollback", {}, "rollback")} className={BTN}>
                {busy === "rollback" ? "جارٍ الرجوع…" : `الرجوع للمفتاح السابق (ينتهي بـ ${state.store.previousLast4})`}
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <input type="password" dir="ltr" autoComplete="off" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="الصق المفتاح الجديد هنا" className={FIELD} style={{ ...MONO, borderColor: "var(--gold)" }} />
            <p className="m-0 text-xs leading-[1.7] text-mut">يُفحص المفتاح أولًا بطلب حقيقي لدى المزود. إن رفضه المزود لا يُحفظ ويبقى المفتاح القديم يعمل.</p>
            <div className="flex gap-2">
              <button type="button" disabled={draft.length < 12 || busy !== ""} onClick={async () => { const keyValue = draft; setDraft(""); if (await post("replace", { key: keyValue }, "replace")) setEditing(false); }} className="min-h-11 cursor-pointer rounded-full border-0 bg-ac px-4 text-xs font-semibold text-onac" style={{ opacity: draft.length >= 12 ? 1 : 0.45 }}>
                {busy === "replace" ? "جارٍ الفحص والحفظ…" : "فحص وحفظ"}
              </button>
              <button type="button" onClick={() => { setEditing(false); setDraft(""); }} className={BTN}>إلغاء</button>
            </div>
          </div>
        )}
        {msg && <p role="status" aria-live="polite" className="m-0 text-[13px] leading-[1.8]" style={{ color: msg.ok ? "var(--ok)" : "var(--bad)" }}>{msg.text}</p>}
        <p className="m-0 text-[11px] leading-[1.7] text-fnt">المفتاح لا يُعرض كاملًا أبدًا؛ تظهر آخر ٤ خانات فقط. يُحفظ مشفّرًا ويسري على كل الخوادم خلال ٣٠ ثانية على الأكثر بلا إعادة نشر.</p>
      </section>

      <section className={SECTION} aria-label="آخر النشاط">
        <h3 className="m-0 text-[15px] font-semibold text-ink">آخر النشاط (٢٠ سجلًا)</h3>
        <p className="m-0 text-[11px] text-fnt">التكلفة بالدولار{provider === "anthropic" ? "، والتوكنات: دخل / خرج" : ""}.</p>
        {state.activity.length === 0 ? <p className="m-0 text-[13px] text-mut">لا يوجد نشاط مسجّل بعد.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed border-collapse text-[11px]">
              <thead><tr className="text-mut">{(isDataProvider(provider) ? ["الوقت", "المهمة", "الوحدات", "التكلفة"] : ["الوقت", "السبب", "التوكنات", "التكلفة"]).map((c) => <th key={c} className="border-b border-ln py-2 text-right font-medium">{c}</th>)}</tr></thead>
              <tbody>
                {state.activity.map((r, i) => (
                  <tr key={i} className="text-ink"><td className="border-b border-ln py-2">{agoAr(r.at)}</td><td className="break-words border-b border-ln py-2">{r.label}</td><td className="border-b border-ln py-2">{toArabicDigits(r.detail)}</td><td className="border-b border-ln py-2" dir="ltr">{toArabicDigits(Number(r.amount).toFixed(6).replace(/\.?0+$/, "") || "0")}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {isDataProvider(provider) && <ProviderCallLog provider={provider} />}
    </div>
  );
}
