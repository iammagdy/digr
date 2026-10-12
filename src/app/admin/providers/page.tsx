"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import { useAdmin, type ProviderStatus } from "@/components/admin/AdminShell";
import { EGP, agoAr, tint } from "@/components/admin/format";

const LLM_P: Record<string, { label: string; keyEnv: string; modelEnv: string; prefix: string; defaultModel: string }> = {
  anthropic: { label: "Anthropic", keyEnv: "ANTHROPIC_API_KEY", modelEnv: "ANTHROPIC_MODEL", prefix: "sk-ant-", defaultModel: "claude-haiku-5-5" },
  openai: { label: "OpenAI", keyEnv: "OPENAI_API_KEY", modelEnv: "OPENAI_MODEL", prefix: "sk-", defaultModel: "gpt-6-luna" },
  fake: { label: "وضع تجريبي", keyEnv: "—", modelEnv: "LLM_MODEL", prefix: "", defaultModel: "fake" },
};
const FALLBACK_AR: Record<string, string> = { llm_disabled: "المساعد متوقف من الإدارة", provider_is_fake: "المزود في الوضع التجريبي", missing_key: "المفتاح غير مضبوط", spend_cap: "تجاوز سقف الإنفاق اليومي" };

const SECTION = "flex flex-col gap-4 rounded-[22px] border border-ln bg-sf p-[18px]";
const FIELD = "min-h-[46px] w-full rounded-xl border border-ln bg-bg px-3.5 text-sm text-ink outline-none text-left";
const MONO = { fontFamily: "ui-monospace,monospace" } as const;

function Switch({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick} className="hit relative h-8 w-[54px] shrink-0 cursor-pointer rounded-full border-0 transition-colors duration-[250ms]" style={{ background: on ? "var(--ok)" : "var(--ln2)" }}>
      <span className="absolute top-[3px] h-[26px] w-[26px] rounded-full bg-white" style={{ right: on ? 3 : 25, boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "right .25s cubic-bezier(.2,.7,.2,1)" }} />
    </button>
  );
}

function Rows({ rows }: { rows: Array<{ k: string; v: string; c: string }> }) {
  return (
    <div className="border-t border-ln pt-1.5">
      {rows.map((r) => (
        <div key={r.k} className="flex min-h-10 items-center justify-between gap-3 border-b border-ln text-xs"><span className="text-mut">{r.k}</span><span className="font-medium" style={{ color: r.c }}>{r.v}</span></div>
      ))}
    </div>
  );
}

export default function AdminProvidersPage() {
  const { providers: shellProviders, refresh, toast, isMobile, range } = useAdmin();
  const [p, setP] = useState<ProviderStatus | null>(shellProviders);
  const [tregCost, setTregCost] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<"llm" | "treg" | null>(null);
  const [model, setModel] = useState("");
  const [tregUrl, setTregUrl] = useState("");
  const [keyEdit, setKeyEdit] = useState<"llm" | "treg" | null>(null);
  const [draft, setDraft] = useState("");
  const [smoke, setSmoke] = useState<"idle" | "run" | { ok: boolean; msg: string }>("idle");
  const [busy, setBusy] = useState(false);

  const load = () => adminFetch<ProviderStatus>("/api/admin/providers").then((r) => { setP(r); setModel(r.llm.model); setTregUrl(r.treg.baseUrl); });
  useEffect(() => { load().catch(() => {}); }, []);
  useEffect(() => { adminFetch<{ cards: { treg: number } }>(`/api/admin/finance?range=${range}`).then((r) => setTregCost(r.cards.treg)).catch(() => {}); }, [range]);

  /** Sends variables to the server (written to the Site + job functions, then redeployed). */
  const save = async (updates: Array<{ key: string; value: string }>, done: string) => {
    if (busy) return false;
    setBusy(true);
    try {
      const res = await adminFetch<{ results: Array<{ ok: boolean; message: string }> }>("/api/admin/providers", { method: "POST", body: JSON.stringify({ updates }) });
      const failed = res.results.filter((r) => !r.ok);
      toast(failed.length ? `${done} — لكن: ${failed[0].message}` : `${done} — يسري بعد إعادة تشغيل الدوال`);
      refresh();
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : "تعذّر الحفظ");
      return false;
    } finally { setBusy(false); }
  };

  if (!p) return <div className="grid gap-3" style={{ gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr" }}>{[0, 1].map((i) => <div key={i} className="h-80 rounded-[22px] bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />)}</div>;

  const L = p.llm, T = p.treg;
  const lp = LLM_P[L.provider] ?? LLM_P.fake;
  const maskedLlm = L.keyLast4 ? `${lp.prefix}••••••••••••${L.keyLast4}` : "غير مضبوط";
  const maskedTreg = T.tokenLast4 ? `treg_••••••••••••${T.tokenLast4}` : "غير مضبوط";

  const llmRows = [
    { k: "الحالة", v: L.enabled ? (L.provider === "fake" ? "مفعّل · وضع تجريبي" : "مفعّل") : "متوقف · وضع احتياطي", c: L.enabled ? "var(--ok)" : "var(--bad)" },
    { k: "المفتاح موجود", v: L.provider === "fake" ? "غير مطلوب" : L.keyConfigured ? "نعم" : "لا", c: "var(--ink)" },
    { k: "آخر استخدام", v: L.lastUsage ? agoAr(L.lastUsage) : "—", c: "var(--ink)" },
    { k: "آخر سبب للوضع الاحتياطي", v: L.fallbackReason ? FALLBACK_AR[L.fallbackReason] ?? L.fallbackReason : "لا يوجد", c: "var(--mut)" },
    { k: "طلبات اليوم", v: `${formatAr(L.callsToday)} طلب · ${EGP(L.costTodayEgp)}`, c: "var(--ink)" },
  ];
  const tregRows = [
    { k: "الحالة", v: T.live ? "مباشر · TREG_LIVE=true" : "متوقف · TREG_LIVE=false", c: T.live ? "var(--ok)" : "var(--bad)" },
    { k: "آخر استدعاء", v: T.lastCall ? agoAr(T.lastCall) : "—", c: "var(--ink)" },
    { k: "استدعاءات اليوم", v: `${formatAr(T.callsToday)} استدعاء`, c: "var(--ink)" },
    { k: `تكلفة آخر ${formatAr(range)} يومًا`, v: tregCost == null ? "…" : EGP(tregCost), c: "var(--ink)" },
  ];

  const toggleLlm = async () => { if (L.enabled) setConfirm("llm"); else if (await save([{ key: "LLM_ENABLED", value: "true" }], "تم تشغيل المساعد الذكي — LLM_ENABLED=true")) setP({ ...p, llm: { ...L, enabled: true } }); };
  const toggleTreg = async () => { if (T.live) setConfirm("treg"); else if (await save([{ key: "TREG_LIVE", value: "true" }], "تم تشغيل الجمع المباشر — TREG_LIVE=true")) setP({ ...p, treg: { ...T, live: true } }); };

  const runSmoke = async () => {
    if (smoke === "run") return;
    setSmoke("run");
    try {
      const r = await adminFetch<{ live_switch: boolean; results: Array<{ ok: boolean; latency_ms: number }>; message_ar: string }>("/api/admin/smoke", { method: "POST" });
      const ok = r.live_switch && r.results.length > 0 && r.results.every((x) => x.ok);
      const avg = r.results.length ? Math.round(r.results.reduce((a, x) => a + x.latency_ms, 0) / r.results.length) : 0;
      setSmoke({ ok, msg: ok ? `✓ الاتصال يعمل · زمن الاستجابة ${formatAr(avg)} مللي ثانية` : r.message_ar });
    } catch (e) { setSmoke({ ok: false, msg: e instanceof Error ? e.message : "تعذّر الفحص" }); }
  };

  const keyBlock = (which: "llm" | "treg") => {
    const masked = which === "llm" ? maskedLlm : maskedTreg;
    const env = which === "llm" ? lp.keyEnv : "TREG_TOKEN";
    const editing = keyEdit === which;
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-mut">{which === "llm" ? `مفتاح API · ${lp.keyEnv}` : "رمز الوصول · TREG_TOKEN"}</span>
        {!editing && !(which === "llm" && L.provider === "fake") && (
          <div className="flex min-h-[46px] items-center gap-2 rounded-xl border border-ln bg-bg ps-3.5 pe-1.5">
            <span dir="ltr" className="flex-1 text-left text-sm text-ink" style={MONO}>{masked}</span>
            <button type="button" onClick={() => { setKeyEdit(which); setDraft(""); }} className="min-h-11 cursor-pointer whitespace-nowrap rounded-[10px] border border-ln2 bg-sf px-3 text-xs text-ink">{which === "llm" ? "تغيير المفتاح" : "تغيير الرمز"}</button>
          </div>
        )}
        {editing && (
          <div className="flex flex-col gap-2" style={{ animation: "up .25s both" }}>
            <input type="password" dir="ltr" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={which === "llm" ? `${lp.prefix}...` : "treg_..."} className={`${FIELD} text-sm`} style={{ ...MONO, borderColor: "var(--gold)" }} />
            <div className="flex gap-2">
              <button
                type="button" disabled={draft.length < 8 || busy}
                onClick={async () => { if (await save([{ key: env, value: draft }], which === "llm" ? `تم حفظ مفتاح ${lp.label}` : "تم حفظ رمز TREG الجديد")) { setKeyEdit(null); setDraft(""); } }}
                className="min-h-11 cursor-pointer rounded-full border-0 bg-ac px-4 text-xs font-semibold text-onac" style={{ opacity: draft.length >= 8 ? 1 : 0.45 }}
              >{which === "llm" ? "حفظ المفتاح" : "حفظ الرمز"}</button>
              <button type="button" onClick={() => { setKeyEdit(null); setDraft(""); }} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-xs text-ink">إلغاء</button>
            </div>
          </div>
        )}
      </div>
    );
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

  return (
    <div data-screen-label="Providers" className="grid items-start gap-3" style={{ gridTemplateColumns: isMobile ? "1fr" : "minmax(0,1fr) minmax(0,1fr)" }}>
      <section className={SECTION}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="m-0 text-[11px] text-fnt">LLM_ENABLED · LLM_PROVIDER</p>
            <h2 className="mb-0 mt-1 text-[17px] font-semibold text-ink">المساعد الذكي (النماذج اللغوية)</h2>
            <p className="mb-0 mt-1 text-xs leading-[1.7] text-mut">يصمم الخطط ويطرح الأسئلة التوضيحية. عند الإيقاف يعمل المساعد بالوضع الاحتياطي بدون استدعاء أي نموذج.</p>
          </div>
          <Switch on={L.enabled} onClick={toggleLlm} label="تشغيل المساعد الذكي" />
        </div>
        {confirmBox("llm", "إيقاف المساعد الذكي سيحوّل كل المحادثات الجديدة للوضع الاحتياطي فورًا. متأكد؟", async () => { setConfirm(null); if (await save([{ key: "LLM_ENABLED", value: "false" }], "تم إيقاف المساعد الذكي — المحادثات تعمل بالوضع الاحتياطي")) setP({ ...p, llm: { ...L, enabled: false } }); })}
        <div>
          <p className="mb-2 mt-0 text-xs font-semibold text-mut">المزود</p>
          <div className="grid grid-cols-3 gap-1 rounded-[14px] bg-sf2 p-1">
            {(["anthropic", "openai", "fake"] as const).map((id) => (
              <button
                key={id} type="button" aria-pressed={L.provider === id} disabled={busy}
                onClick={async () => {
                  if (L.provider === id) return;
                  const m = LLM_P[id].defaultModel;
                  if (await save([{ key: "LLM_PROVIDER", value: id }, { key: LLM_P[id].modelEnv, value: m }], `LLM_PROVIDER=${id}`)) { setModel(m); setP({ ...p, llm: { ...L, provider: id, model: m, keyEnv: LLM_P[id].keyEnv, modelEnv: LLM_P[id].modelEnv } }); }
                }}
                className="min-h-[46px] cursor-pointer rounded-[10px] border-0 text-xs font-semibold" style={{ background: L.provider === id ? "var(--sf)" : "transparent", color: L.provider === id ? "var(--ink)" : "var(--mut)", boxShadow: L.provider === id ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}
              >{id === "fake" ? "تجريبي" : LLM_P[id].label}</button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-mut">النموذج · {lp.modelEnv}</span>
          <input type="text" dir="ltr" value={model || L.model} onChange={(e) => setModel(e.target.value)} onBlur={() => { const v = (model || L.model).trim(); if (v && v !== L.model) void save([{ key: lp.modelEnv, value: v }], `${lp.modelEnv}=${v}`); }} className={FIELD} style={MONO} />
        </label>
        {keyBlock("llm")}
        <Rows rows={llmRows} />
      </section>

      <section className={SECTION}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="m-0 text-[11px] text-fnt">TREG_LIVE · treg.to</p>
            <h2 className="mb-0 mt-1 text-[17px] font-semibold text-ink">مزود البيانات TREG</h2>
            <p className="mb-0 mt-1 text-xs leading-[1.7] text-mut">ينفّذ كل عمليات جمع البيانات العامة. عند الإيقاف تُرفض المهام الجديدة ويُسترد الرصيد المحجوز للمستخدم.</p>
          </div>
          <Switch on={T.live} onClick={toggleTreg} label="تشغيل الجمع المباشر" />
        </div>
        {confirmBox("treg", "إيقاف TREG يوقف جمع البيانات على المنصة كلها، وأي مهمة جديدة سترجع رصيدها للمستخدم. متأكد؟", async () => { setConfirm(null); if (await save([{ key: "TREG_LIVE", value: "false" }], "تم إيقاف TREG — المهام الجديدة سترجع رصيدها تلقائيًا")) setP({ ...p, treg: { ...T, live: false } }); })}
        {keyBlock("treg")}
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-mut">عنوان الخدمة · TREG_BASE_URL</span>
          <input type="text" dir="ltr" value={tregUrl || T.baseUrl} onChange={(e) => setTregUrl(e.target.value)} onBlur={() => { const v = (tregUrl || T.baseUrl).trim(); if (v && v !== T.baseUrl) void save([{ key: "TREG_BASE_URL", value: v }], `TREG_BASE_URL=${v}`); }} className={FIELD} style={MONO} />
        </label>
        <div className="flex flex-wrap items-center gap-2.5">
          <button type="button" onClick={runSmoke} className="flex min-h-11 cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border border-ln2 bg-sf px-4 text-[13px] text-ink">
            {smoke === "run" && <span className="h-3.5 w-3.5 rounded-full border-2 border-ln2 border-t-ink" style={{ animation: "spin .8s linear infinite" }} />}فحص الاتصال
          </button>
          {typeof smoke === "object" && <span className="text-xs leading-[1.7]" style={{ color: smoke.ok ? "var(--ok)" : "var(--bad)", animation: "fade .3s both" }}>{smoke.msg}</span>}
        </div>
        <Rows rows={tregRows} />
      </section>

      <p className="m-0 text-xs leading-[1.9] text-fnt" style={{ gridColumn: "1 / -1" }}>المفاتيح تُحفظ في متغيرات بيئة الخادم ولا تُعرض كاملة أبدًا — تظهر آخر ٤ خانات فقط. أي تغيير هنا يُرسل للخادم ويسري على الدوال بعد إعادة التشغيل.</p>
    </div>
  );
}
