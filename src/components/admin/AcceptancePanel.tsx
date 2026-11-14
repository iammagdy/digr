"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { toArabicDigits } from "@/lib/arabicDigits";

/**
 * LIVE ACCEPTANCE (docs/intelligence/ACCEPTANCE-WORKFLOW.md), inside the agent console: the campaign's state, the scoped Intelligence switches of the TEST ACCOUNT ONLY (on for a bounded time, restored exactly),
 * the L1–L4 scenarios, what the test account's missions cost against the $0.30 ceiling, and a downloadable report. Every action goes to /api/admin/acceptance (admin only, audited).
 * While the campaign's hard ceiling is not enforceable the server refuses to turn a switch on or create a scenario mission; the screen says why and disables those buttons. Restoring is always allowed.
 * No identifier for L1/L2 is typed, kept or sent here: the owner types their own on the reverse-lookup screen.
 */
const SECTION = "flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4";
const BTN = "hit min-h-11 cursor-pointer rounded-xl border border-ln2 bg-sf px-4 text-sm font-semibold text-ink disabled:opacity-50";

interface FlagState { key: string; set: boolean; onForTestAccount: boolean; onForOthers: boolean; scopedToTestAccountOnly: boolean }
interface Scenario { id: "L1" | "L2" | "L3" | "L4"; titleAr: string; ceilingUsd: number; route: "agent_console" | "reverse_lookup"; intelligence: boolean; checksAr: string[] }
interface SpendRow { id: string; status: string; created_at: string; planning_llm_usd: number; execution_llm_usd: number; planning_treg_usd: number; execution_treg_usd: number; reserved_points: number | null; charged_points: number | null; is_addon?: true }
export interface State {
  account: { id: string } | null;
  campaign: { keys: string[]; started_at: string; expires_at: string; expired: boolean; started_by: string } | null;
  flags: FlagState[];
  isolated: boolean;
  budget: { enforceable: boolean; ceilingUsd: number | null; reasons: string[] };
  ceilingUsd: number;
  minutes: { min: number; max: number };
  keys: string[];
  l4Keys: string[];
  scenarios: Scenario[];
  spend: { since: string; totalUsd: number; missions: SpendRow[] } | null;
}

const REASON_AR: Record<string, string> = {
  model_calls_not_reserved: "طلبات النموذج لا يُحجز حدّها الأقصى قبل إرسالها؛ ميزانيته تُفحص بعد كل دورة.",
  provider_caps_shared_and_estimated: "حدود المزودين يومية ومشتركة مع كل العملاء، وتحجز التقدير لا الحد الأقصى، ولا تشمل النموذج.",
  no_aggregate_ledger: "لا يوجد سجل واحد يجمع إنفاق كل المزودين والنموذج ويحجز قبل كل طلب (بوابة الإنفاق غير مطبّقة).",
};
const ERROR_AR: Record<string, string> = {
  budget_not_enforceable: "رُفض: السقف الصارم للحملة غير قابل للتطبيق بعد.",
  campaign_active: "توجد حملة نشطة بالفعل.",
  key_already_set: "مفتاح مضبوط مسبقًا؛ لا يُكتب فوقه.",
  test_account_missing: "حساب الاختبار غير موجود.",
  restore_conflict: "مفتاح غيّره أحد أثناء الحملة؛ تُرك كما هو.",
  restore_incomplete: "لم تكتمل الاستعادة؛ أعد المحاولة.",
  intelligence_on: "مفاتيح الذكاء مفعّلة؛ L3 يعمل بالمسار الحالي فقط.",
  campaign_not_active: "L4 يحتاج حملة نشطة بكل مفاتيحه.",
  not_isolated: "مفتاح مفعّل لغير حساب الاختبار.",
};
const STATUS_AR: Record<string, string> = { queued: "في الانتظار", planning: "يخطّط", needs_input: "ينتظر إجابة", plan_ready: "الخطة جاهزة", approved: "معتمدة", executing: "ينفّذ", completed: "اكتملت", failed: "فشلت", unserved: "لم تُخدم", cancelled: "أُلغيت" };

const usd = (n: number) => `${toArabicDigits(n.toFixed(4))} دولار`;
const hhmm = (iso: string) => toArabicDigits(new Date(iso).toLocaleString("ar-EG", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "numeric", hour12: false }));
const missionUsd = (m: SpendRow) => m.planning_llm_usd + m.execution_llm_usd + m.planning_treg_usd + m.execution_treg_usd;

function flagLabel(f: FlagState, campaign: State["campaign"]): string {
  if (!f.set) return "غير مضبوط";
  if (f.onForOthers) return "مفعّل لغير حساب الاختبار";
  if (f.onForTestAccount) return campaign ? `مفعّل لحساب الاختبار حتى ${hhmm(campaign.expires_at)}` : "مفعّل لحساب الاختبار";
  return "مضبوط ومنتهي (يُزال بالاستعادة)";
}

export interface AcceptancePanelViewProps {
  state: State | null;
  chosen: string[] | null;
  minutes: number;
  busy: boolean;
  onChoose: (keys: string[]) => void;
  onMinutes: (n: number) => void;
  onAction: (body: Record<string, unknown>, done: string) => void;
  onReport: () => void;
}

/** The screen itself, pure (the tests render it with a state; the wrapper below loads the state and sends the actions). */
export function AcceptancePanelView({ state, chosen, minutes, busy, onChoose, onMinutes, onAction, onReport }: AcceptancePanelViewProps) {
  const keys = chosen ?? state?.l4Keys ?? [];
  const enforceable = state?.budget.enforceable === true;
  const anySet = Boolean(state?.flags.some((f) => f.set));
  const campaignLive = Boolean(state?.campaign && !state.campaign.expired);

  return (
    <section className={SECTION} data-testid="acceptance-panel" aria-label="حملة القبول الحي">
      <b className="text-[13px]">حملة القبول الحي (حساب الاختبار فقط)</b>
      <p className="m-0 text-[12px] leading-[1.8] text-ink2">تشغّل مفاتيح الذكاء لحساب الاختبار وحده لمدة محددة ثم تعيدها كما كانت، وتنشئ مهام القبول عبر هذه الصفحة نفسها، ويبقى اعتماد السعر كما هو. كل خطوة تُسجَّل في سجل الإدارة.</p>
      {!state ? <p className="m-0 text-[13px] text-ink2">جارٍ التحميل…</p> : (
        <>
          {!enforceable ? (
            <div className="rounded-xl border border-ln2 p-3 text-[13px] leading-[1.9] text-bad" role="alert" data-testid="acceptance-budget-blocked">
              السقف الصارم للحملة ({usd(state.ceilingUsd)}) غير قابل للتطبيق بعد، لذلك لا تُفعَّل المفاتيح ولا تُنشأ مهام القبول:
              <ul className="m-0 pr-5">{state.budget.reasons.map((r) => <li key={r}>{REASON_AR[r] ?? r}</li>)}</ul>
            </div>
          ) : <p className="m-0 text-[13px] text-ink" data-testid="acceptance-budget-ok">السقف الصارم للحملة مطبَّق: {usd(state.budget.ceilingUsd ?? 0)}.</p>}
          <p className={`m-0 text-[13px] ${state.isolated ? "text-ink2" : "text-bad"}`} role={state.isolated ? undefined : "alert"} data-testid="acceptance-isolation">
            {state.account ? (state.isolated ? "المفاتيح معزولة: لا يراها أي حساب غير حساب الاختبار." : "تنبيه: مفتاح ذكاء مفعّل لغير حساب الاختبار.") : "حساب الاختبار غير موجود."}
          </p>

          <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="acceptance-flags">
            {state.flags.map((f) => (
              <li key={f.key} className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={keys.includes(f.key)} disabled={!enforceable || campaignLive} onChange={(e) => onChoose(e.target.checked ? [...keys, f.key] : keys.filter((k) => k !== f.key))} />
                  <span dir="ltr" className="font-mono text-[12px]">{f.key}</span>
                </label>
                <span className={f.onForOthers ? "text-bad" : "text-ink2"}>{flagLabel(f, state.campaign)}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-end gap-2 text-[13px] text-ink">
            <label className="flex flex-col gap-1">المدة (دقيقة)
              <input className="min-h-11 w-24 rounded-xl border border-ln2 bg-sf px-3 text-sm" type="number" min={state.minutes.min} max={state.minutes.max} value={minutes} disabled={!enforceable || campaignLive} onChange={(e) => onMinutes(Math.round(Number(e.target.value) || 0))} data-testid="acceptance-minutes" />
            </label>
            <button type="button" className={BTN} disabled={busy || !enforceable || campaignLive || keys.length === 0} onClick={() => onAction({ action: "start", keys, minutes }, "فُعّلت المفاتيح لحساب الاختبار")} data-testid="acceptance-start">فعّل لحساب الاختبار</button>
            <button type="button" className={BTN} disabled={busy || (!state.campaign && !anySet)} onClick={() => onAction({ action: "restore" }, "أُعيدت المفاتيح كما كانت")} data-testid="acceptance-restore">أعِد المفاتيح كما كانت</button>
          </div>

          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="acceptance-scenarios">
            {state.scenarios.map((s) => (
              <li key={s.id} className="flex flex-col gap-1 rounded-xl border border-ln p-3 text-[13px] text-ink" data-testid={`acceptance-scenario-${s.id}`}>
                <span><b dir="ltr">{s.id}</b> · {s.titleAr} · السقف {usd(s.ceilingUsd)}</span>
                <span className="text-[12px] text-ink2">{s.checksAr.join(" · ")}</span>
                {s.route === "reverse_lookup" ? (
                  <span className="text-[12px] text-ink2">يُنفَّذ من صفحة <a className="underline" href="/admin/reverse-lookup">البحث العكسي</a> بمعرّفاتك أنت فقط، بعد تطبيق السقف؛ لا يُكتب أي معرّف هنا.</span>
                ) : (
                  <div><button type="button" className={BTN} disabled={busy || !enforceable || (s.intelligence ? !campaignLive : anySet)} onClick={() => onAction({ action: "create_scenario", scenario: s.id }, `أُنشئت مهمة ${s.id}؛ اعتمد سعرها من القائمة أدناه`)} data-testid={`acceptance-create-${s.id}`}>أنشئ مهمة {s.id}</button></div>
                )}
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-1 text-[13px] text-ink" data-testid="acceptance-spend">
            {state.spend ? (
              <>
                <span>إنفاق مهام حساب الاختبار منذ {hhmm(state.spend.since)}: {usd(state.spend.totalUsd)} من سقف {usd(state.ceilingUsd)}</span>
                {state.spend.missions.map((m) => (
                  <span key={m.id} className="text-[12px] text-ink2"><span dir="ltr" className="font-mono">{m.id}</span> · {STATUS_AR[m.status] ?? m.status}{m.is_addon ? " · طلب على ملف مُسلَّم" : ""} · {usd(missionUsd(m))}</span>
                ))}
              </>
            ) : <span className="text-bad">تعذّر قراءة الإنفاق.</span>}
          </div>
          <div><button type="button" className={BTN} onClick={onReport} data-testid="acceptance-report">نزّل تقرير القبول</button></div>
        </>
      )}
    </section>
  );
}

/** The report the screen downloads: the state as read (the test account's id only; no e-mail, no identifier of anybody). */
export function acceptanceReportOf(state: State, generatedAt: string) {
  return { kind: "diger_acceptance_report", generated_at: generatedAt, account_id: state.account?.id ?? null, campaign: state.campaign, flags: state.flags, isolated: state.isolated, budget: state.budget, ceiling_usd: state.ceilingUsd, scenarios: state.scenarios.map((s) => ({ id: s.id, ceiling_usd: s.ceilingUsd })), spend: state.spend };
}

export function AcceptancePanel({ toast }: { toast: (m: string) => void }) {
  const [state, setState] = useState<State | null>(null);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setState(await adminFetch<State>("/api/admin/acceptance")); } catch (e) { toast(e instanceof Error ? e.message : "تعذّر التحميل"); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const onAction = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try { await adminFetch("/api/admin/acceptance", { method: "POST", body: JSON.stringify(body) }); toast(done); } catch (e) { const code = e instanceof Error ? e.message : ""; toast(ERROR_AR[code] ?? (code || "تعذّر التنفيذ")); } finally { setBusy(false); await load(); }
  };

  const onReport = () => {
    if (!state) return;
    const report = acceptanceReportOf(state, new Date().toISOString());
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `acceptance-report-${report.generated_at.slice(0, 19).replace(/[:T]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return <AcceptancePanelView state={state} chosen={chosen} minutes={minutes} busy={busy} onChoose={setChosen} onMinutes={setMinutes} onAction={(b, d) => void onAction(b, d)} onReport={onReport} />;
}
