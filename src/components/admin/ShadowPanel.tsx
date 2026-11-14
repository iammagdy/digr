"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { toArabicDigits } from "@/lib/arabicDigits";
import { codeLabelAr, EVIDENCE_AR, SEVERITY_AR } from "@/lib/agentMission/shadow/labels";
import { DIMENSIONS, type CaseResult, type DimensionId, type Gate, type Risk, type Severity } from "@/lib/agentMission/shadow/types";

/**
 * PHASE 7 (PR-7.1), ADMIN ONLY: the shadow comparison of today's behaviour with the proposed Intelligence behaviour, inside the agent console. OFFLINE: it replays stored requests, approved plans and fixtures (and any request an admin types)
 * through both, and shows every difference with how well it is backed. It calls no provider and no model, reads no switch, writes nothing and cannot turn anything on; the text on this screen is redacted by the server.
 */
const SECTION = "flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4";
const BTN = "hit min-h-11 cursor-pointer rounded-xl border border-ln2 bg-sf px-4 text-sm font-semibold text-ink disabled:opacity-50";

interface IndexRow { id: string; origin: string; group: string | null; request: string; verdict: Severity; counts: { regression: number; review: number; improvement: number }; customer: string; test: string }
interface Summary {
  assumptions: string[];
  interpreterEvents: { available: false; reason: string };
  counts: { cases: number; byOrigin: Record<string, number>; byVerdict: Record<Severity, number>; findings: Record<Severity, number>; verifiedImprovements: number; unlabelledImprovements: number; acceptedRegressions: number; unacceptedRegressions: number };
  gates: Gate[];
  passed: boolean;
  risks: Risk[];
  digest: string;
  cases: IndexRow[];
}

const ORIGIN_AR: Record<string, string> = { audit_scenario: "سيناريوهات التدقيق", stored_mission: "مهام معتمدة محفوظة", understanding_baseline: "خط أساس الفهم", exclusion: "ملف الاستبعاد", ad_hoc: "طلب مكتوب الآن" };
const STATUS_AR: Record<string, string> = { supported: "مدعوم", partial: "جزئي", unsupported: "غير مدعوم", blocked: "ممنوع", needs_clarification: "يحتاج توضيحًا" };
const TONE: Record<Severity, string> = { regression: "text-[#b3261e]", review: "text-[#8a5a00]", improvement: "text-[#1b6b3a]", same: "text-ink2", info: "text-ink2" };
const num = (n: number) => toArabicDigits(String(n));

function CaseView({ c }: { c: CaseResult }) {
  const [dim, setDim] = useState<DimensionId>("understanding");
  const byDim = useMemo(() => DIMENSIONS.map((d) => ({ ...d, findings: c.findings.filter((f) => f.dimension === d.id) })), [c]);
  const current = byDim.find((d) => d.id === dim)!;
  const sorted = [...current.findings].sort((a, b) => ["regression", "review", "improvement", "same", "info"].indexOf(a.severity) - ["regression", "review", "improvement", "same", "info"].indexOf(b.severity));
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-ln p-3 text-[12px] leading-[1.9]" data-testid="shadow-case">
      <div className="text-ink" dir="auto">{c.request}</div>
      <div className="text-ink2">
        اليوم: مسار «{c.baseline.route}» · المقترح للعميل: {STATUS_AR[c.proposed.production.status] ?? c.proposed.production.status} ({c.proposed.production.stages.map((s) => s.operation).join(" ← ") || "لا مراحل"}) · لحساب الاختبار: {STATUS_AR[c.proposed.test.status] ?? c.proposed.test.status}
      </div>
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {byDim.map((d) => {
          const worstSeverity = (["regression", "review", "improvement", "same", "info"] as Severity[]).find((s) => d.findings.some((f) => f.severity === s));
          return (
            <button key={d.id} type="button" role="tab" aria-selected={dim === d.id} className={`rounded-lg border px-2.5 py-1 ${dim === d.id ? "border-ink bg-sf font-semibold" : "border-ln"} ${worstSeverity ? TONE[worstSeverity] : "text-ink2"}`} onClick={() => setDim(d.id)}>
              {d.labelAr} ({num(d.findings.length)})
            </button>
          );
        })}
      </div>
      {sorted.length === 0 ? <p className="m-0 text-ink2">لا نتائج في هذا البُعد.</p> : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {sorted.map((f, i) => (
            <li key={`${f.code}_${i}`} className="rounded-lg border border-ln p-2">
              <span className={`font-semibold ${TONE[f.severity]}`}>{SEVERITY_AR[f.severity]}</span> · {codeLabelAr(f.code)}
              <div className="text-ink2" dir="auto">{f.detail}</div>
              <div className="text-ink2">الدليل: {EVIDENCE_AR[f.evidence]}{f.verified ? " · مُتحقَّق منه بوسم أو قاعدة صارمة" : ""}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ShadowPanel({ toast }: { toast: (message: string, kind?: string) => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Severity>("all");
  const [origin, setOrigin] = useState<string>("all");
  const [open, setOpen] = useState<CaseResult | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { adminFetch<Summary>("/api/admin/shadow").then(setSummary).catch(() => setError("تعذّر تحميل المقارنة.")); }, []);

  const openCase = useCallback(async (id: string) => {
    try { setOpen((await adminFetch<{ case: CaseResult }>(`/api/admin/shadow?case=${encodeURIComponent(id)}`)).case); } catch { toast("تعذّر فتح الحالة.", "error"); }
  }, [toast]);

  const runAdHoc = async () => {
    setBusy(true);
    try { setOpen((await adminFetch<{ case: CaseResult }>("/api/admin/shadow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: text }) })).case); } catch { toast("تعذّرت المقارنة.", "error"); } finally { setBusy(false); }
  };

  const rows = (summary?.cases ?? []).filter((r) => (filter === "all" || r.verdict === filter) && (origin === "all" || r.origin === origin));

  return (
    <section className={SECTION} data-testid="shadow-panel" aria-label="المقارنة الظلّية">
      <b className="text-[13px]">المقارنة الظلّية: السلوك الحالي مقابل السلوك المقترح</b>
      <p className="m-0 text-[12px] leading-[1.8] text-ink2">للمشرف فقط وبلا اتصال: تعيد طلبات وخططًا محفوظة وملفات تجريبية عبر السلوكين وتعرض كل فرق مع قوة دليله. لا تستدعي مزوّدًا ولا نموذجًا، ولا تقرأ مفاتيح الذكاء ولا تغيّرها، ولا تكتب شيئًا. النص المعروض منقّح من البيانات الشخصية.</p>
      {error ? <p className="m-0 text-[13px] text-[#b3261e]">{error}</p> : null}
      {!summary ? (error ? null : <p className="m-0 text-[13px] text-ink2">جارٍ التحميل…</p>) : (
        <>
          <div className="flex flex-wrap gap-3 text-[13px]" data-testid="shadow-summary">
            <span><b>{num(summary.counts.cases)}</b> حالة</span>
            <span className={TONE.regression}>تراجع: <b>{num(summary.counts.unacceptedRegressions)}</b></span>
            <span className={TONE.review}>يحتاج مراجعة: <b>{num(summary.counts.findings.review)}</b></span>
            <span className={TONE.improvement}>تحسّن مُتحقَّق: <b>{num(summary.counts.verifiedImprovements)}</b> · بلا وسم: <b>{num(summary.counts.unlabelledImprovements)}</b></span>
            <span>بوابات الانحدار: <b>{summary.passed ? "ناجحة" : "فاشلة"}</b></span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px]" data-testid="shadow-gates">
            {summary.gates.map((g) => (<li key={g.id} className={g.passed ? "text-[#1b6b3a]" : "text-[#b3261e]"}>{g.passed ? "✓" : "✗"} {g.rule}{g.passed ? "" : ` (${num(g.failing.length)})`}</li>))}
          </ul>
          <details className="text-[12px] leading-[1.9] text-ink2"><summary className="cursor-pointer text-ink">ما الذي تفترضه المقارنة؟</summary>
            <ul className="m-0 list-disc ps-5">{summary.assumptions.map((a) => <li key={a} dir="auto">{a}</li>)}<li dir="auto">{summary.interpreterEvents.reason}</li></ul>
          </details>
          <div className="flex flex-col gap-1.5" data-testid="shadow-risks">
            <b className="text-[12px]">مخاطر مفتوحة</b>
            {summary.risks.map((r) => (<div key={r.id} className="rounded-xl border border-ln p-2 text-[12px] leading-[1.9]"><span className={r.severity === "high" ? TONE.regression : TONE.review}>{r.severity === "high" ? "عالية" : r.severity === "medium" ? "متوسطة" : "منخفضة"}</span> · {r.textAr}</div>))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <label className="flex items-center gap-1">الحكم <select className="min-h-9 rounded-lg border border-ln2 bg-sf px-2" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}><option value="all">الكل</option>{(["regression", "review", "improvement", "same"] as Severity[]).map((s) => <option key={s} value={s}>{SEVERITY_AR[s]} ({num(summary.counts.byVerdict[s])})</option>)}</select></label>
            <label className="flex items-center gap-1">المصدر <select className="min-h-9 rounded-lg border border-ln2 bg-sf px-2" value={origin} onChange={(e) => setOrigin(e.target.value)}><option value="all">الكل</option>{Object.keys(summary.counts.byOrigin).map((o) => <option key={o} value={o}>{ORIGIN_AR[o] ?? o} ({num(summary.counts.byOrigin[o])})</option>)}</select></label>
            <span className="text-ink2">{num(rows.length)} حالة معروضة</span>
          </div>
          <ul className="m-0 flex max-h-80 list-none flex-col gap-1 overflow-auto p-0" data-testid="shadow-cases">
            {rows.map((r) => (
              <li key={r.id}><button type="button" className="w-full cursor-pointer rounded-lg border border-ln px-2.5 py-1.5 text-start text-[12px] leading-[1.8]" onClick={() => openCase(r.id)}>
                <span className={`font-semibold ${TONE[r.verdict]}`}>{SEVERITY_AR[r.verdict]}</span> · <span dir="auto">{r.request.slice(0, 90)}</span> <span className="text-ink2">({ORIGIN_AR[r.origin] ?? r.origin})</span>
              </button></li>
            ))}
          </ul>
        </>
      )}
      <div className="flex flex-col gap-2">
        <b className="text-[12px]">قارن طلبًا تكتبه الآن (لا يُحفظ ولا يُرسل إلى أي جهة)</b>
        <textarea className="min-h-20 w-full rounded-xl border border-ln2 bg-sf p-3 text-sm" maxLength={2000} placeholder="مثال: ٥٠ شركة مقاولات في مصر ومواقعها الرسمية" value={text} onChange={(e) => setText(e.target.value)} />
        <div><button type="button" className={BTN} disabled={busy || text.trim().length < 3} onClick={runAdHoc} data-testid="shadow-run">قارن</button></div>
      </div>
      {open ? <CaseView c={open} /> : null}
    </section>
  );
}
