"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import { useAdmin, type ProviderStatus } from "@/components/admin/AdminShell";
import { ProviderTab } from "@/components/admin/ProviderTab";
import { tint } from "@/components/admin/format";

const LLM_P: Record<string, { label: string; modelEnv: string; defaultModel: string }> = {
  anthropic: { label: "Anthropic", modelEnv: "ANTHROPIC_MODEL", defaultModel: "claude-haiku-5-5" },
  openai: { label: "OpenAI", modelEnv: "OPENAI_MODEL", defaultModel: "gpt-6-luna" },
  fake: { label: "وضع تجريبي", modelEnv: "LLM_MODEL", defaultModel: "fake" },
};
const FALLBACK_AR: Record<string, string> = { llm_disabled: "المساعد متوقف من الإدارة", provider_is_fake: "المزود في الوضع التجريبي", missing_key: "المفتاح غير مضبوط", spend_cap: "تجاوز سقف الإنفاق اليومي" };

const SECTION = "flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4";
const FIELD = "min-h-[46px] w-full rounded-xl border border-ln bg-bg px-3.5 text-sm text-ink outline-none text-left";
const MONO = { fontFamily: "ui-monospace,monospace" } as const;

function Switch({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick} className="hit relative h-8 w-[54px] shrink-0 cursor-pointer rounded-full border-0 transition-colors duration-[250ms]" style={{ background: on ? "var(--ok)" : "var(--ln2)" }}>
      <span className="absolute top-[3px] h-[26px] w-[26px] rounded-full bg-white" style={{ right: on ? 3 : 25, boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "right .25s cubic-bezier(.2,.7,.2,1)" }} />
    </button>
  );
}

type TabId = "treg" | "firecrawl" | "contextdev" | "anthropic";

export default function AdminProvidersPage() {
  const { providers: shellProviders, refresh, toast, isMobile } = useAdmin();
  const [tab, setTab] = useState<TabId>("treg");
  const [p, setP] = useState<ProviderStatus | null>(shellProviders);
  const [confirm, setConfirm] = useState<"llm" | "treg" | null>(null);
  const [model, setModel] = useState("");
  const [tregUrl, setTregUrl] = useState("");
  const [smoke, setSmoke] = useState<"idle" | "run" | { ok: boolean; msg: string }>("idle");
  const [busy, setBusy] = useState(false);

  const load = () => adminFetch<ProviderStatus>("/api/admin/providers").then((r) => { setP(r); setModel(r.llm.model); setTregUrl(r.treg.baseUrl); });
  useEffect(() => { load().catch(() => {}); }, []);

  /** Non-secret switches and settings only. Keys never travel here: they use the validated, encrypted key store. */
  const save = async (updates: Array<{ key: string; value: string }>, done: string) => {
    if (busy) return false;
    setBusy(true);
    try {
      const res = await adminFetch<{ success?: boolean; results: Array<{ ok: boolean; message: string }> }>("/api/admin/providers", { method: "POST", body: JSON.stringify({ updates }) });
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length || res.success === false) { toast(`تعذر حفظ الإعداد — ${failed[0]?.message || "حاول مرة أخرى"}`); return false; }
      toast(`${done} — يسري على الطلبات الجديدة`);
      refresh();
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : "تعذّر الحفظ");
      return false;
    } finally { setBusy(false); }
  };

  if (!p) return <div className="h-80 rounded-[22px] bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />;

  const L = p.llm, T = p.treg;
  const lp = LLM_P[L.provider] ?? LLM_P.fake;

  const toggleLlm = async () => { if (L.enabled) setConfirm("llm"); else if (await save([{ key: "LLM_ENABLED", value: "true" }], "تم تشغيل المساعد الذكي")) setP({ ...p, llm: { ...L, enabled: true } }); };
  const toggleTreg = async () => { if (T.live) setConfirm("treg"); else if (await save([{ key: "TREG_LIVE", value: "true" }], "تم تشغيل الجمع المباشر")) setP({ ...p, treg: { ...T, live: true } }); };

  const runSmoke = async () => {
    if (smoke === "run") return;
    setSmoke("run");
    try {
      const r = await adminFetch<{ live_switch: boolean; results: Array<{ ok: boolean; latency_ms: number }>; message_ar: string }>("/api/admin/smoke", { method: "POST" });
      const ok = r.live_switch && r.results.length > 0 && r.results.every((x) => x.ok);
      const avg = r.results.length ? Math.round(r.results.reduce((a, x) => a + x.latency_ms, 0) / r.results.length) : 0;
      setSmoke({ ok, msg: ok ? `✓ الاستخراج التجريبي يعمل · زمن الاستجابة ${formatAr(avg)} مللي ثانية` : r.message_ar });
    } catch (e) { setSmoke({ ok: false, msg: e instanceof Error ? e.message : "تعذّر الفحص" }); }
  };

  const confirmBox = (which: "llm" | "treg", text: string, onOff: () => void) => confirm === which && (
    <div className="flex flex-col gap-2.5 rounded-[14px] px-3.5 py-3" style={{ background: tint("var(--bad)", 10), animation: "up .25s both" }}>
      <p className="m-0 text-[13px] leading-[1.8] text-bad">{text}</p>
      <div className="flex gap-2">
        <button type="button" onClick={onOff} className="min-h-11 cursor-pointer rounded-full border-0 bg-bad px-4 text-xs font-semibold text-white">إيقاف</button>
        <button type="button" onClick={() => setConfirm(null)} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-xs text-ink">إلغاء</button>
      </div>
    </div>
  );

  const tregControls = (
    <section className={SECTION} aria-label="إعدادات الجمع المباشر">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="m-0 text-[15px] font-semibold text-ink">الجمع المباشر</h3>
          <p className="mb-0 mt-1 text-xs leading-[1.7] text-mut">مفتاح تشغيل منفصل عن حالة الاتصال. عند الإيقاف تُرفض المهام الجديدة ويُسترد الرصيد المحجوز للمستخدم.</p>
        </div>
        <Switch on={T.live} onClick={toggleTreg} label="تشغيل الجمع المباشر" />
      </div>
      {confirmBox("treg", "إيقاف الجمع المباشر يوقف جمع البيانات على المنصة كلها، وأي مهمة جديدة سترجع رصيدها للمستخدم. متأكد؟", async () => { setConfirm(null); if (await save([{ key: "TREG_LIVE", value: "false" }], "تم إيقاف الجمع المباشر")) setP({ ...p, treg: { ...T, live: false } }); })}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-mut">عنوان الخدمة</span>
        <input type="text" dir="ltr" value={tregUrl || T.baseUrl} onChange={(e) => setTregUrl(e.target.value)} onBlur={() => { const v = (tregUrl || T.baseUrl).trim(); if (v && v !== T.baseUrl) void save([{ key: "TREG_BASE_URL", value: v }], "تم حفظ عنوان الخدمة"); }} className={FIELD} style={MONO} />
      </label>
      <div className="flex flex-wrap items-center gap-2.5">
        <button type="button" onClick={runSmoke} className="flex min-h-11 cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border border-ln2 bg-sf px-4 text-[13px] text-ink">
          {smoke === "run" && <span className="h-3.5 w-3.5 rounded-full border-2 border-ln2 border-t-ink" style={{ animation: "spin .8s linear infinite" }} />}اختبار استخراج تجريبي (يستهلك رصيدًا قليلًا)
        </button>
        {typeof smoke === "object" && <span className="text-xs leading-[1.7]" style={{ color: smoke.ok ? "var(--ok)" : "var(--bad)" }}>{smoke.msg}</span>}
      </div>
    </section>
  );

  const llmControls = (
    <section className={SECTION} aria-label="إعدادات المساعد الذكي">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="m-0 text-[15px] font-semibold text-ink">المساعد الذكي</h3>
          <p className="mb-0 mt-1 text-xs leading-[1.7] text-mut">يصمم الخطط ويطرح الأسئلة التوضيحية. عند الإيقاف يعمل المساعد بالوضع الاحتياطي بدون استدعاء أي نموذج.</p>
        </div>
        <Switch on={L.enabled} onClick={toggleLlm} label="تشغيل المساعد الذكي" />
      </div>
      {confirmBox("llm", "إيقاف المساعد الذكي سيحوّل كل المحادثات الجديدة للوضع الاحتياطي فورًا. متأكد؟", async () => { setConfirm(null); if (await save([{ key: "LLM_ENABLED", value: "false" }], "تم إيقاف المساعد الذكي")) setP({ ...p, llm: { ...L, enabled: false } }); })}
      <div className="grid grid-cols-3 gap-1 rounded-[14px] bg-sf2 p-1">
        {(["anthropic", "openai", "fake"] as const).map((id) => (
          <button key={id} type="button" aria-pressed={L.provider === id} disabled={busy}
            onClick={async () => { if (L.provider === id) return; const m = LLM_P[id].defaultModel; if (await save([{ key: "LLM_PROVIDER", value: id }, { key: LLM_P[id].modelEnv, value: m }], "تم تغيير المزود")) { setModel(m); setP({ ...p, llm: { ...L, provider: id, model: m, modelEnv: LLM_P[id].modelEnv } }); } }}
            className="min-h-[46px] cursor-pointer rounded-[10px] border-0 text-xs font-semibold" style={{ background: L.provider === id ? "var(--sf)" : "transparent", color: L.provider === id ? "var(--ink)" : "var(--mut)" }}
          >{id === "fake" ? "تجريبي" : LLM_P[id].label}</button>
        ))}
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-mut">النموذج</span>
        <input type="text" dir="ltr" value={model || L.model} onChange={(e) => setModel(e.target.value)} onBlur={() => { const v = (model || L.model).trim(); if (v && v !== L.model) void save([{ key: lp.modelEnv, value: v }], "تم حفظ النموذج"); }} className={FIELD} style={MONO} />
      </label>
      {L.fallbackReason && <p className="m-0 text-xs text-mut">آخر سبب للوضع الاحتياطي: {FALLBACK_AR[L.fallbackReason] ?? L.fallbackReason}</p>}
    </section>
  );

  const tabs: Array<[TabId, string]> = [["treg", "مزود البيانات"], ["firecrawl", "Firecrawl"], ["contextdev", "Context.dev"], ["anthropic", "مزود النموذج الذكي"]];

  return (
    <div data-screen-label="Providers" className="flex flex-col gap-3.5" style={{ maxWidth: isMobile ? undefined : 860 }}>
      <div role="tablist" aria-label="مزودو الخدمة" className="grid grid-cols-2 gap-1 rounded-[14px] bg-sf2 p-1 sm:grid-cols-4">
        {tabs.map(([id, label]) => (
          <button key={id} id={`tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`panel-${id}`} onClick={() => setTab(id)}
            className="min-h-[46px] cursor-pointer rounded-[10px] border-0 text-[13px] font-semibold" style={{ background: tab === id ? "var(--sf)" : "transparent", color: tab === id ? "var(--ink)" : "var(--mut)", boxShadow: tab === id ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}>{label}</button>
        ))}
      </div>
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "treg"
          ? <ProviderTab key="treg" provider="treg" onChanged={refresh}>{tregControls}</ProviderTab>
          : tab === "firecrawl" || tab === "contextdev"
          ? <ProviderTab key={tab} provider={tab} onChanged={refresh} />
          : <ProviderTab key="anthropic" provider="anthropic" onChanged={refresh}>{llmControls}</ProviderTab>}
      </div>
    </div>
  );
}
