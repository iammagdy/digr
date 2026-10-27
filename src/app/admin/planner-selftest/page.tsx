"use client";

import { useEffect, useRef, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { toArabicDigits } from "@/lib/arabicDigits";
import { useAdmin } from "@/components/admin/AdminShell";
import { selfTestCsv, type SelfTestRow } from "@/lib/modelPlanner/selfTestCsv";

const SECTION = "flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4";
const BTN = "hit min-h-11 cursor-pointer rounded-xl border border-ln2 bg-sf px-4 text-sm font-semibold text-ink disabled:opacity-50";

interface CaseInfo { id: string; group: string; request: string; expected: string; note: string }
interface Health {
  catalog: { endpoints: number; source: string } | { error: string };
  model: string;
  lastPlannerError: { at: string; reason: string } | null;
  lastExploration: { at: string; endpoint: string; result: string; httpStatus: number | null; rows: number | null; costUsd: number } | null;
}
interface Info { capUsd: number; keyConfigured: boolean; health: Health; cases: CaseInfo[] }
type StepResult = { stopped: "cap"; spentUsd: number; capUsd: number } | { stopped?: undefined; row: SelfTestRow; spentUsd: number; capUsd: number };

/** USD with Arabic-Indic digits: this screen is admin-only, one of the few places a cost in dollars is shown. */
const usd = (n: number) => `${toArabicDigits(n.toFixed(4))} دولار`;
const num = (n: number | null) => (n === null ? "—" : toArabicDigits(String(Math.round(n * 1000) / 1000)));

export default function PlannerSelfTestPage() {
  const { toast } = useAdmin();
  const [info, setInfo] = useState<Info | null>(null);
  const [rows, setRows] = useState<SelfTestRow[]>([]);
  const [spent, setSpent] = useState(0);
  const [running, setRunning] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const stop = useRef(false);
  const [seeding, setSeeding] = useState(false);
  const [seedNote, setSeedNote] = useState("");

  useEffect(() => { adminFetch<Info>("/api/admin/planner-selftest").then(setInfo).catch((e) => toast(e instanceof Error ? e.message : "تعذّر التحميل")); }, [toast]);

  async function run() {
    if (running || !info) return;
    stop.current = false;
    setRows([]); setSpent(0); setNote("");
    const runId = `r${Date.now().toString(36)}`;
    let total = 0;
    for (const c of info.cases) {
      if (stop.current) { setNote("أوقفتَ الفحص."); break; }
      setRunning(c.id);
      try {
        const r = await adminFetch<StepResult>("/api/admin/planner-selftest", { method: "POST", body: JSON.stringify({ caseId: c.id, runId, spentUsd: total }) });
        total = r.spentUsd; setSpent(total);
        if (r.stopped === "cap") { setNote("توقّف الفحص عند الحد الأعلى لتكلفة التشغيلة."); break; }
        setRows((prev) => [...prev, r.row]);
      } catch (e) {
        toast(e instanceof Error ? e.message : "تعذّر تشغيل الطلب");
        setNote(`توقّف الفحص عند الطلب ${c.id}.`);
        break;
      }
    }
    setRunning(null);
  }

  async function loadRecipes() {
    if (seeding) return;
    setSeeding(true); setSeedNote("");
    try {
      const r = await adminFetch<{ inserted: number; present: number; failed: number; tableApplied: boolean }>("/api/admin/recipes-seed", { method: "POST" });
      setSeedNote(r.tableApplied ? `أُضيفت ${toArabicDigits(r.inserted)} وصفة، وكانت ${toArabicDigits(r.present)} موجودة، وتعذّر ${toArabicDigits(r.failed)}.` : "جدول الوصفات غير مُطبَّق بعد: لم يُحمَّل شيء.");
    } catch (e) {
      setSeedNote(e instanceof Error ? e.message : "تعذّر التحميل");
    } finally { setSeeding(false); }
  }

  function exportCsv() {
    const blob = new Blob([selfTestCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "planner-selftest.csv"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const passed = rows.filter((r) => r.pass).length;
  const h = info?.health;
  return (
    <div className="flex flex-col gap-4" dir="rtl">
      <section className={SECTION} aria-label="فحص المخطط">
        <h2 className="m-0 text-base font-semibold text-ink">فحص المخطط</h2>
        <p className="m-0 text-[13px] font-light leading-[1.9] text-ink2">يشغّل ٣٠ طلبًا بالعربية عبر المخطط الحقيقي (النموذج الحقيقي واستدعاءات العيّنة الحقيقية) ويتوقف قبل أي عرض سعر: لا مهمة ولا حجز ولا خصم ولا بيانات عميل. لكل طلب نتيجة متوقعة محفوظة معه، ويُحكم عليه نجاحًا أو فشلًا.</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN} disabled={!info || Boolean(running) || !info.keyConfigured} onClick={run} data-testid="selftest-run">{running ? `يعمل: ${running}` : "شغّل الفحص"}</button>
          {running ? <button type="button" className={BTN} onClick={() => { stop.current = true; }}>إيقاف</button> : null}
          <button type="button" className={BTN} disabled={rows.length === 0} onClick={exportCsv} data-testid="selftest-csv">تصدير CSV</button>
        </div>
        {info && !info.keyConfigured ? <p className="m-0 text-[13px] text-bad">مفتاح النموذج غير مضبوط.</p> : null}
        <p className="m-0 text-[13px] text-ink" data-testid="selftest-cost" aria-live="polite">تكلفة هذه التشغيلة {usd(spent)} من حدّ {usd(info?.capUsd ?? 0.3)} · نجح {toArabicDigits(passed)} من {toArabicDigits(rows.length)}</p>
        {note ? <p className="m-0 text-[13px] text-ink2" role="status">{note}</p> : null}
      </section>

      <section className={SECTION} aria-label="الوصفات المثبتة" data-testid="recipes-seed">
        <h3 className="m-0 text-[13px] font-semibold text-ink">الوصفات المثبتة</h3>
        <p className="m-0 text-[13px] font-light leading-[1.9] text-ink2">يحمّل وصفات مراجَعة للخدمات التي ثبت عملها: منشورات حساب وموضوع على إكس، وتعليقات تيك توك وفيسبوك (فيديو أو منشور أو كلمة)، والشركات وصنّاع القرار. لا يغيّر ولا يحذف أي وصفة محفوظة، ويضيف الناقص فقط.</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN} disabled={seeding} onClick={loadRecipes} data-testid="recipes-seed-button">{seeding ? "جارٍ التحميل…" : "تحميل الوصفات المثبتة"}</button>
          {seedNote ? <span className="text-[13px] text-ink" role="status">{seedNote}</span> : null}
        </div>
      </section>

      {h ? (
        <section className={SECTION} aria-label="صحة المخطط" data-testid="selftest-health">
          <h3 className="m-0 text-[13px] font-semibold text-ink">صحة المخطط</h3>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
            <dt className="text-ink2">الفهرس المحمّل</dt><dd className="m-0 text-ink" dir="ltr">{"error" in h.catalog ? `خطأ: ${h.catalog.error}` : `${h.catalog.endpoints} endpoints`}</dd>
            <dt className="text-ink2">النموذج</dt><dd className="m-0 text-ink" dir="ltr">{h.model}</dd>
            <dt className="text-ink2">آخر خطأ للمخطط</dt><dd className="m-0 text-ink" dir="ltr">{h.lastPlannerError ? `${h.lastPlannerError.at.slice(0, 19)} · ${h.lastPlannerError.reason}` : "—"}</dd>
            <dt className="text-ink2">آخر استكشاف</dt><dd className="m-0 text-ink" dir="ltr">{h.lastExploration ? `${h.lastExploration.at.slice(0, 19)} · ${h.lastExploration.endpoint} · ${h.lastExploration.result} · HTTP ${h.lastExploration.httpStatus ?? "-"} · rows ${h.lastExploration.rows ?? "-"}` : "—"}</dd>
          </dl>
        </section>
      ) : null}

      <section className={SECTION} aria-label="النتائج">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]" data-testid="selftest-table">
            <thead>
              <tr className="text-right text-ink2">
                {["#", "الطلب", "المتوقع", "النتيجة", "الحكم", "ما فُهم", "الخدمة المختارة والبدائل", "المعاملات ومصدرها", "الفترة", "عيّنة", "سعر الوحدة", "الحجز", "الأدوار", "الرموز", "تكلفة النموذج", "تكلفة المصدر", "السبب"].map((t) => <th key={t} className="border-b border-ln px-2 py-1 font-semibold">{t}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="align-top" style={{ background: r.pass ? undefined : "var(--sf2)" }}>
                  <td className="border-b border-ln px-2 py-1" dir="ltr">{r.id}</td>
                  <td className="border-b border-ln px-2 py-1">{r.request}</td>
                  <td className="border-b border-ln px-2 py-1" dir="ltr">{r.expected}</td>
                  <td className="border-b border-ln px-2 py-1" dir="ltr">{r.outcome}</td>
                  <td className="border-b border-ln px-2 py-1 font-semibold" style={{ color: r.pass ? "var(--ok)" : "var(--bad)" }}>{r.pass ? "نجح" : "فشل"}</td>
                  <td className="border-b border-ln px-2 py-1">{r.understood}</td>
                  <td className="border-b border-ln px-2 py-1" dir="ltr">{r.endpoints.join(" > ") || "—"}{r.alternativesTried.length > 0 ? <div className="text-mut">{r.alternativesTried.map((a) => `${a.endpoint}=${a.outcome}${a.httpStatus ? `/${a.httpStatus}` : ""}`).join(" ; ")}</div> : null}</td>
                  <td className="border-b border-ln px-2 py-1" dir="ltr">{r.params.map((p) => `${p.name}=${p.value} (${p.source})`).join(" ; ") || "—"}</td>
                  <td className="border-b border-ln px-2 py-1" dir="ltr">{r.window}</td>
                  <td className="border-b border-ln px-2 py-1">{toArabicDigits(r.sampleRows)}</td>
                  <td className="border-b border-ln px-2 py-1">{num(r.unitPricePoints)}</td>
                  <td className="border-b border-ln px-2 py-1">{num(r.holdPoints)}</td>
                  <td className="border-b border-ln px-2 py-1">{toArabicDigits(r.turns)}</td>
                  <td className="border-b border-ln px-2 py-1" dir="ltr">{r.tokensIn}/{r.tokensOut}</td>
                  <td className="border-b border-ln px-2 py-1">{usd(r.modelUsd)}</td>
                  <td className="border-b border-ln px-2 py-1">{usd(r.providerUsd)}</td>
                  <td className="border-b border-ln px-2 py-1" dir="ltr">{r.reason || r.endReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
